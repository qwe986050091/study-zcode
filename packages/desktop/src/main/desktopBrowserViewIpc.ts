// INV-01 所有通道名必须只从 PlatformChannels 取，本文件内不得出现字面量通道名；守住位置：全部 ipcMain.handle 与 ipcMain.on 的首参；改错故障：主进程监听名与 preload 暴露名不一致，renderer 调用永远挂起。
// INV-02 通道注册必须是启动期一次性动作，同名通道不得二次注册，也不提供反注册；守住位置：registerDesktopBrowserIpcHandlers 与 registerBrowserViewIpcHandlers；改错故障：第二次注册直接抛错，后续所有通道都未注册。
// INV-03 每个回调都必须先用 BrowserWindow.fromWebContents 反查发送方窗口，再做参数解析与副作用；守住位置：九个处理器的首个语句；改错故障：窗口已销毁仍继续执行，后续以无效窗口 id 记账。
// INV-04 windowId 只能来自 main 侧反查的 win.id，禁止从 payload 读取；守住位置：attach 与三个 residency 调用的 windowId 字段；改错故障：renderer 可伪造窗口 id，把 guest 挂到他人窗口。
// INV-05 字符串参数必须一律经 nonEmptyStringSchema 解析，不能手写类型断言；守住位置：key、tabId、workspaceKey、sessionId、remoteSessionId 的所有解析点；改错故障：空串进入 manager，与「未指定」共用同一批缓存项。
// INV-06 webContentsId 必须是正的安全整数，residencyGeneration 必须是非负安全整数；守住位置：attach 与 detach 的整数守卫；改错故障：负数或浮点 id 被当成合法 guest，attach 到不存在的 webContents。
// INV-07 可选字段只有在值确为 undefined 时才省略，显式 undefined 与缺键不可混同；守住位置：attach 的四个条件展开；改错故障：一次不带 workspaceKey 的调用抹掉已有工作区归属。
// INV-08 active 与 residencyGeneration 的类型校验必须早于任何依赖调用；守住位置：attach 回调中段两处 typeof 与安全整数判断；改错故障：布尔字段传字符串时按真值生效，标签被错误激活。
// INV-09 attach 依赖缺失或返回 undefined 时必须回落到失败信封，不能抛错；守住位置：attach 的 ?? 兜底对象；改错故障：renderer 收到 rejected promise，界面停在加载态且无恢复入口。
// INV-10 失败信封必须同时给出 ok 为 false、reason 与 recoveryRequested 三个字段；守住位置：window-mismatch 与 not-found 两个返回点；改错故障：renderer 读不到 recoveryRequested，无法触发重建视图。
// INV-11 未知 key 必须返回 not-found 信封而不是静默成功；守住位置：attach 的 ?? 分支；改错故障：renderer 以为视图已挂载，实际没有任何 guest，画面永久空白。
// INV-12 detach 在窗口失效时返回 false 而不是抛错；守住位置：detach 回调的早返回；改错故障：关闭竞态下卸载流程中断，残留 guest 继续占用内存。
// INV-13 viewport 允许 null 表示清空，非 null 时必须过 browserViewportInputSchema；守住位置：updateViewport 回调的三元分支；改错故障：宽高为负或缺失的视口被下发，guest 渲染成零尺寸。
// INV-14 视口更新必须把 tabId 与 windowId 成对交给依赖，不得只按 tabId 定位；守住位置：updateBrowserGuestViewport 调用参数；改错故障：同 tabId 存在于多窗口时改错窗口的布局。
// INV-15 截图就绪通知必须使用 ipcMain.on 单向通道，不能改成 handle；守住位置：ScreenshotSurfaceReady 的注册；改错故障：页面侧的 send 无人接收，首帧截图永远等不到。
// INV-16 截图通知必须同时传 win.id 与 event.sender.id，二者不可互相替代；守住位置：reportBrowserScreenshotSurfaceReady 的入参；改错故障：同一窗口内多个 guest 无法区分，截到错误标签。
// INV-17 residency 上报的布尔字段一律用 Boolean 归一，不信任 payload 原值；守住位置：reportBrowserTabResidency 的参数构造；改错故障：undefined 被当成可见，标签不会被挂起而持续耗电。
// INV-18 作用域展开必须排在显式字段之前，保证 windowId 不被 payload 覆盖；守住位置：close、report、ensure 三处的对象展开顺序；改错故障：操作落到他人窗口，造成越权关闭标签。
// INV-19 suspend 确认的 tabId 与 generation 必须成对校验并做数值归一；守住位置：acknowledgeBrowserTabSuspend 调用；改错故障：字符串 generation 与数字记录永不相等，标签无法挂起。
// INV-20 restoreTabs 依赖缺失或返回 undefined 时必须回落成空数组，且校验失败要在副作用前抛错；守住位置：restore 回调的 ?? 兜底与 parseBrowserTabScope；改错故障：renderer 遍历 undefined 崩溃，标签树整片白屏。
import { BrowserWindow, ipcMain } from "electron";
import {
  PlatformChannels,
  browserViewportInputSchema,
  nonEmptyStringSchema,
  type BrowserViewCloseTabRequest,
  type BrowserGuestAttachResult,
  type BrowserViewResidencyReportPayload,
  type BrowserViewRestoredTabShell,
  type BrowserViewRestoreTabsRequest,
  type BrowserViewportSize,
  type BrowserViewScreenshotSurfaceReadyPayload,
} from "@zcode/shared";
import { registerBrowserDataIpcHandlers } from "./desktopBrowserDataIpc.js";

export type AttachBrowserGuest = (
  key: string,
  webContentsId: number,
  options?: {
    active?: boolean;
    windowId?: number;
    workspaceKey?: string;
    remoteSessionId?: string;
    sessionId?: string;
    residencyGeneration?: number;
  },
) => BrowserGuestAttachResult | Promise<BrowserGuestAttachResult>;

export type UpdateBrowserGuestViewport = (
  tabId: string,
  viewport: BrowserViewportSize | null,
  windowId: number,
) => Promise<void> | void;

export type ReportBrowserScreenshotSurfaceReady = (
  windowId: number,
  senderWebContentsId: number,
  payload: BrowserViewScreenshotSurfaceReadyPayload,
) => void;

export interface BrowserViewResidencyIpcHandlers {
  detachBrowserGuest?(
    key: string,
    webContentsId: number,
    windowId: number,
  ): Promise<boolean> | boolean;
  closeBrowserTab?(
    payload: BrowserViewCloseTabRequest & { windowId: number },
  ): Promise<void> | void;
  reportBrowserTabResidency?(
    payload: BrowserViewResidencyReportPayload & { windowId: number },
  ): Promise<void> | void;
  acknowledgeBrowserTabSuspend?(payload: {
    tabId: string;
    generation: number;
    windowId: number;
  }): Promise<void> | void;
  ensureBrowserTabResident?(
    payload: BrowserViewCloseTabRequest & { windowId: number },
  ): Promise<void> | void;
  restoreBrowserTabs?(
    payload: BrowserViewRestoreTabsRequest & { windowId: number },
  ): Promise<BrowserViewRestoredTabShell[]>;
}

export function registerBrowserViewIpcHandlers(
  attachBrowserGuest?: AttachBrowserGuest,
  updateBrowserGuestViewport?: UpdateBrowserGuestViewport,
  reportBrowserScreenshotSurfaceReady?: ReportBrowserScreenshotSurfaceReady,
  residencyHandlers: BrowserViewResidencyIpcHandlers = {},
) {
  // renderer 只能拿到 guest webContentsId，必须由 main 绑定发送方窗口后再 attach，
  // 否则相同 key 在多个窗口之间可能错误复用 BrowserGuestManager 状态。
  // [并发] attach 走 handle 而不是 on：renderer 必须先拿到 attach 结果，
  // 才能决定显示视图还是「不可用」占位，单向通道会把失败拖成超时。
  // [失败路径] 依赖未注入时不抛错，而是回落到 not-found 信封，让「平台不支持」
  // 与「真找不到 guest」共用一条降级路径，renderer 只需处理一种失败形状。
  // 校验顺序是窗口 → key → webContentsId → 可选字段：窗口先失效时 payload 一律不碰，
  // 避免把窗口竞态误报成参数错误，也避免为已关闭窗口的请求做无谓解析；win 失效时直接返回。
  // [权衡] 不复用 parseBrowserTabScope：attach 的字段集合与标签作用域不同，
  // 强行合并会把 workspaceKey 的「可选」语义在标签路径上变成必填。
  ipcMain.handle(
    PlatformChannels.BrowserViewAttachGuest,
    async (
      event,
      payload: {
        key: string;
        webContentsId: number;
        active?: boolean;
        workspaceKey?: string;
        remoteSessionId?: string;
        sessionId?: string;
        residencyGeneration?: number;
      },
    ) => {
      const win = BrowserWindow.fromWebContents(event.sender);
      if (!win || win.isDestroyed()) {
        // [失败路径] 窗口反查失败时返回完整信封而不是抛错：窗口关闭与 IPC 到达是竞态，
        // 抛错只会让 renderer 收到无法归因的异常，重试也无从下手。
        // 信封必须带齐 ok false、reason 与 recoveryRequested，形状与正常结果一致，
        // 少一个字段 renderer 就读不到 recoveryRequested，重试入口不会出现。
        // [权衡] window-mismatch 不复用 not-found：前者表示窗口已不存在，调用方应放弃；
        // 后者表示窗口在但 guest 没找到，调用方可以重建视图，两者恢复动作不同。
        // 该分支必须早于任何 schema 解析，否则非法窗口会把 ZodError 抛给 renderer。
        return { ok: false, reason: "window-mismatch", recoveryRequested: false };
      }
      const key = nonEmptyStringSchema.parse(payload.key);
      if (!Number.isSafeInteger(payload.webContentsId) || payload.webContentsId <= 0) {
        throw new TypeError("webContentsId must be a positive safe integer");
      }
      // [失败路径] webContentsId 与 residencyGeneration 用显式安全整数判断：zod number
      // 会接受浮点与 NaN，而这两者进 guest 表后永远查不到，表现为「attach 成功但画面空白」。
      // key 与 workspaceKey 等字符串字段交给 nonEmptyStringSchema：空串在 manager 里
      // 与「未指定」共用同一批缓存项，会把两个不同会话折叠成一条记录。
      // 校验失败抛出的错误会原样变成 renderer 侧的 rejected invoke，这是刻意的：
      // 参数形状错误属于调用方 bug，必须暴露，不能降级成 ok false 被当成可恢复失败。
      // [权衡] active 用 typeof 而非 schema：它允许缺省，schema 会把缺省变成必填。
      if (payload.active !== undefined && typeof payload.active !== "boolean") {
        throw new TypeError("active must be a boolean");
      }
      if (
        payload.residencyGeneration !== undefined &&
        (!Number.isSafeInteger(payload.residencyGeneration) || payload.residencyGeneration < 0)
      ) {
        throw new TypeError("residencyGeneration must be a non-negative safe integer");
      }
      const workspaceKey =
        payload.workspaceKey === undefined
          ? undefined
          : nonEmptyStringSchema.parse(payload.workspaceKey);
      const remoteSessionId =
        payload.remoteSessionId === undefined
          ? undefined
          : nonEmptyStringSchema.parse(payload.remoteSessionId);
      const sessionId =
        payload.sessionId === undefined ? undefined : nonEmptyStringSchema.parse(payload.sessionId);
      // [事务] 可选字段用条件展开而不是直接传值：manager 侧靠「键是否存在」
      // 区分「沿用旧值」与「清空」，显式 undefined 会被当成清空，
      // 让一次不带 workspaceKey 的 attach 抹掉上一次记录的工作区归属。
      // windowId 无条件放在最后：它是 main 侧唯一可信的归属，
      // 即使 payload 伪造同名字段也进不了这个对象字面量。
      // [失败路径] 依赖返回 undefined 时回落到 not-found 信封，而不是把 undefined 交给 renderer，
      // 否则错误会推迟到界面访问 ok 字段时爆出，堆栈与真实原因完全脱节。
      return ((await attachBrowserGuest?.(key, payload.webContentsId, {
        ...(payload.active === undefined ? {} : { active: payload.active }),
        ...(workspaceKey === undefined ? {} : { workspaceKey }),
        ...(remoteSessionId === undefined ? {} : { remoteSessionId }),
        ...(sessionId === undefined ? {} : { sessionId }),
        ...(payload.residencyGeneration === undefined
          ? {}
          : { residencyGeneration: payload.residencyGeneration }),
        windowId: win.id,
      })) ?? {
        ok: false,
        reason: "not-found",
        recoveryRequested: false,
      }) satisfies BrowserGuestAttachResult;
    },
  );

  ipcMain.handle(
    PlatformChannels.BrowserViewDetachGuest,
    async (event, payload: { key: string; webContentsId: number }): Promise<boolean> => {
      const win = BrowserWindow.fromWebContents(event.sender);
      if (!win || win.isDestroyed()) return false;
      const key = nonEmptyStringSchema.parse(payload.key);
      if (!Number.isSafeInteger(payload.webContentsId) || payload.webContentsId <= 0) {
        throw new TypeError("webContentsId must be a positive safe integer");
      }
      return (
        (await residencyHandlers.detachBrowserGuest?.(key, payload.webContentsId, win.id)) ?? false
      );
    },
  );

  ipcMain.handle(
    PlatformChannels.BrowserViewUpdateViewport,
    async (
      event,
      payload: {
        tabId: string;
        viewport: BrowserViewportSize | null;
      },
    ) => {
      const win = BrowserWindow.fromWebContents(event.sender);
      if (!win || win.isDestroyed()) return;
      const tabId = nonEmptyStringSchema.parse(payload.tabId);
      const viewport =
        payload.viewport === null ? null : browserViewportInputSchema.parse(payload.viewport);
      await updateBrowserGuestViewport?.(tabId, viewport, win.id);
    },
  );

  // [并发] 这条通道必须用 on 注册：截图就绪只是单向通知，renderer 不需要回执，
  // 用 handle 会让页面侧的 send 找不到对应 invoke，永远等不到 resolve。
  // [失败路径] 回调内不等待任何异步动作，通知完即返回；一旦这里抛错，
  // Electron 只能打印未捕获异常，首帧仍缺失，但日志指向的事件与真实原因相距很远。
  // [权衡] 通道只传 payload，不传 windowId：窗口由 sender 反查，
  // 允许 renderer 用参数声明「我是哪个窗口」等于开放越权入口。
  // sender.id 与 windowId 同时下发，是因为同一窗口内可能有多个 guest 共用一条通道。
  ipcMain.on(
    PlatformChannels.BrowserViewScreenshotSurfaceReady,
    (event, payload: BrowserViewScreenshotSurfaceReadyPayload) => {
      const win = BrowserWindow.fromWebContents(event.sender);
      if (!win || win.isDestroyed()) return;
      reportBrowserScreenshotSurfaceReady?.(win.id, event.sender.id, payload);
    },
  );

  ipcMain.handle(
    PlatformChannels.BrowserViewCloseTabFromRenderer,
    async (event, payload: BrowserViewCloseTabRequest) => {
      const win = BrowserWindow.fromWebContents(event.sender);
      if (!win || win.isDestroyed()) return;
      await residencyHandlers.closeBrowserTab?.({
        ...parseBrowserTabScope(payload),
        windowId: win.id,
      });
    },
  );

  ipcMain.handle(
    PlatformChannels.BrowserViewReportResidency,
    async (event, payload: BrowserViewResidencyReportPayload) => {
      const win = BrowserWindow.fromWebContents(event.sender);
      if (!win || win.isDestroyed()) return;
      // [事务] 上报是全量快照而非增量：调度器按快照整体替换，缺字段等价于 false，
      // 所以下面逐个 Boolean 归一，而不是把 payload 原值展开后再补 windowId。
      // [失败路径] 处理器缺失时静默跳过：候选窗口或旧主进程未接入 residency 属于正常差异，
      // 抛错会把 renderer 的定时上报变成错误风暴。
      // [权衡] 保留 payload 的未知字段，是为了版本不同步时新字段能穿透；
      // 代价是 windowId 必须显式覆盖，见 parseBrowserTabScope 的展开顺序说明。
      await residencyHandlers.reportBrowserTabResidency?.({
        ...payload,
        ...parseBrowserTabScope(payload),
        selected: Boolean(payload.selected),
        visible: Boolean(payload.visible),
        currentTask: Boolean(payload.currentTask),
        loading: Boolean(payload.loading),
        windowId: win.id,
      });
    },
  );

  ipcMain.handle(
    PlatformChannels.BrowserViewSuspendReady,
    async (event, payload: { tabId: string; generation: number }) => {
      const win = BrowserWindow.fromWebContents(event.sender);
      if (!win || win.isDestroyed()) return;
      // [事务] 确认必须带回原始 generation：标签可能在确认到达前被重新激活，
      // generation 不匹配时调度器丢弃这次确认，避免把新的活跃错误挂起。
      // generation 走 Number 归一而不是 schema 校验，因为 renderer 侧可能传字符串；
      // 归一后仍要与主进程记录比较，缺失或 NaN 会自然不匹配，落回「忽略」。
      // [失败路径] 处理器缺失时静默返回：窗口关闭期间的迟到确认不该产生错误。
      // tabId 仍要过 schema，空串会让确认落到一个永不存在的标签上。
      await residencyHandlers.acknowledgeBrowserTabSuspend?.({
        tabId: nonEmptyStringSchema.parse(payload.tabId),
        generation: Number(payload.generation),
        windowId: win.id,
      });
    },
  );

  ipcMain.handle(
    PlatformChannels.BrowserViewEnsureResident,
    async (event, payload: BrowserViewCloseTabRequest) => {
      const win = BrowserWindow.fromWebContents(event.sender);
      if (!win || win.isDestroyed()) return;
      await residencyHandlers.ensureBrowserTabResident?.({
        ...parseBrowserTabScope(payload),
        windowId: win.id,
      });
    },
  );

  ipcMain.handle(
    PlatformChannels.BrowserViewRestoreTabs,
    async (event, payload: BrowserViewRestoreTabsRequest) => {
      const win = BrowserWindow.fromWebContents(event.sender);
      if (!win || win.isDestroyed()) return [];
      return (
        // [事务] 恢复顺序固定为「先解析作用域、再调处理器、最后兜底空数组」：
        // 解析失败要能在没有副作用时抛错，而不是恢复一半才发现 workspaceKey 非法。
        // [失败路径] 处理器缺失或返回 undefined 时回落成空数组，renderer 拿到可遍历结果，
        // 标签树显示为「无标签」，而不是在渲染阶段因遍历 undefined 崩溃。
        // [权衡] remoteSessionId 与 sessionId 用真值判断而非 undefined 判断：
        // 空串对这两个字段没有意义，按缺省处理可以少一次必然失败的解析。
        // windowId 同样只在 main 侧补，payload 里的同名字段不会参与。
        (await residencyHandlers.restoreBrowserTabs?.({
          workspaceKey: nonEmptyStringSchema.parse(payload.workspaceKey),
          ...(payload.remoteSessionId
            ? {
                remoteSessionId: nonEmptyStringSchema.parse(payload.remoteSessionId),
              }
            : {}),
          ...(payload.sessionId
            ? { sessionId: nonEmptyStringSchema.parse(payload.sessionId) }
            : {}),
          windowId: win.id,
        })) ?? []
      );
    },
  );
}

export function registerDesktopBrowserIpcHandlers(
  attachBrowserGuest: AttachBrowserGuest | undefined,
  updateBrowserGuestViewport: UpdateBrowserGuestViewport | undefined,
  logger: {
    info: (...args: unknown[]) => void;
    warn: (...args: unknown[]) => void;
  },
  reportBrowserScreenshotSurfaceReady?: ReportBrowserScreenshotSurfaceReady,
  residencyHandlers?: BrowserViewResidencyIpcHandlers,
) {
  registerBrowserViewIpcHandlers(
    attachBrowserGuest,
    updateBrowserGuestViewport,
    reportBrowserScreenshotSurfaceReady,
    residencyHandlers,
  );
  registerBrowserDataIpcHandlers(logger);
}

// [权衡] 四个 residency 入口共用这一处作用域归一，而不是各自解析：
// 分散实现时新增字段只需漏改一处，就会出现「关闭成功、恢复拒绝」的非对称行为。
// 返回新对象而非原地改写 payload：payload 来自 IPC，调用方可能继续持有引用，
// 就地改写会让「原始入参」与「校验结果」无法区分，排查时看不出哪一步动了值。
// 必填字段在这里统一抛错，调用点只负责补 windowId，不再重复判空。
function parseBrowserTabScope(payload: BrowserViewCloseTabRequest): BrowserViewCloseTabRequest {
  return {
    tabId: nonEmptyStringSchema.parse(payload.tabId),
    workspaceKey: nonEmptyStringSchema.parse(payload.workspaceKey),
    sessionId: nonEmptyStringSchema.parse(payload.sessionId),
    ...(payload.remoteSessionId
      ? { remoteSessionId: nonEmptyStringSchema.parse(payload.remoteSessionId) }
      : {}),
  };
}
