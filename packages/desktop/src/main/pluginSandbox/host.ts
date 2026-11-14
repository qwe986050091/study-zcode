// INV-01 宿主能力只安装一次：已安装时直接返回旧实例，重复安装会让同一 IPC channel 二次注册；守住位置：installPluginSandboxHost 首行；改错故障：第二次注册抛错，插件沙箱整体不可用。
// INV-02 每个沙箱的 guest 必须同时存在于 registry、guests、detachByKey，或三处都不存在；守住位置：attachGuest 与 onDispose；改错故障：残留 guest 继续以旧 partition 读写存储，清除数据也清不干净。
// INV-03 partition 名形如 persist:plugin-sandbox-v[12]-<hash>，v 前缀不得更改；守住位置：clearBrowserData 的目录正则；改错故障：旧版本 partition 不再被清理，用户数据残留。
// INV-04 清数据顺序固定为「停止 guest → 清 storage → 清 cache」；守住位置：clearBrowserData 与 stopGuest；改错故障：仍存活的 guest 在清理后重新写入存储，用户以为已清空。
// INV-05 stopGuest 用 about:blank 导航真正卸载旧文档，而不是只 close 包装对象；守住位置：stopGuest；改错故障：iframe 仍持有原文档继续写 storage，隔离边界失效。
// INV-06 同一 guest 的停止流程必须串行化，重复调用复用同一个 Promise；守住位置：stopping 这个 WeakMap；改错故障：并发 stop 引发 close 与导航竞争，渲染进程异常退出。
// INV-07 所有 IPC 入口必须先按 event.sender.id 校验沙箱归属，再触碰 registry；守住位置：ExecutionActive 与 Dispose 与 ConsumeUserGesture；改错故障：任意 renderer 可释放他人沙箱，形成越权。
// INV-08 IPC 入参一律先经 sandboxCaptureSchema 解析结构，非法形状直接拒绝；守住位置：CopyImage 首段；改错故障：畸形参数进入截图路径，抛错或截到错误区域。
// INV-09 initId 必须与登记时一致，旧 initId 的迟到请求只能被丢弃；守住位置：CopyImage 的 isCurrent 与 Dispose；改错故障：旧页面把新页面的截图写进剪贴板。
// INV-10 截图存在 TOCTOU 窗口，await 之后必须重新校验 isCurrent；守住位置：CopyImage 第二次身份检查；改错故障：把已销毁页面的残帧复制给用户，泄露上一实例画面。
// INV-11 权限确认框的 parent 必须是登记该沙箱的宿主窗口；守住位置：permissions.prompt 的父窗口解析；改错故障：对话框挂错窗口或被页面伪造，用户误授权摄像头。
// INV-12 未知 sandboxId 或不匹配 sender 的消息一律静默丢弃，不得回退到默认放行；守住位置：Dispose 与 ConsumeUserGesture 的早返回；改错故障：未登记沙箱仍能消费用户手势，绕过权限闸门。
// INV-13 clearBrowserData 期间 clearing 必须为真，新登记一律抛错；守住位置：registerFromHost 首行；改错故障：清理与登记交错，新 guest 在已清空的 partition 上留下半套数据。
// INV-14 活动租约按 sandboxId 唯一持有，重复 acquire 不得叠加；守住位置：syncExecution 对 state.lease 的判空；改错故障：release 次数不匹配，窗口永不进入省电。
// INV-15 租约失效事件只能释放仍属于自己的那一次；守住位置：invalidated abort 回调里的身份比较；改错故障：旧租约释放掉新租约，插件执行中画面被节流卡死。
// INV-16 ownerWebContentsId 的 destroyed 监听每个窗口只挂一次；守住位置：watchedOwners 集合与 attachGuest；改错故障：监听器累积，窗口关闭时重复释放并抛错。
// INV-17 宿主 webContents 销毁时必须释放其名下全部登记，插件进程崩溃不得波及主进程；守住位置：registry.disposeOwner 调用点；改错故障：僵尸登记占用配额，后续窗口无法再建沙箱。
// INV-18 配额由 registryMaxEntries 决定，超限必须拒绝而不是驱逐在用实例；守住位置：createPluginSandboxRegistry 入参；改错故障：在用沙箱被顶掉，页面白屏。
// INV-19 隐藏页面靠租约维持低频推进，禁止全局关闭 backgroundThrottling；守住位置：syncExecution 的 markPrepared；改错故障：同窗其他 guest 空转耗电，或隐藏插件不再推进。
// INV-20 will-prevent-unload 只在停止期间临时拦截，结束后必须移除；守住位置：stopGuest 的 finally；改错故障：监听器泄漏使后续正常卸载被永久阻止。
import type { Locale } from "@zcode/shared";
import { PlatformChannels } from "@zcode/shared";
import type { PluginSandboxHandle, PluginSandboxRegisterInput } from "@zcode/shared/mcp-apps";
import {
  BrowserWindow,
  clipboard,
  nativeImage,
  MessageChannelMain,
  app,
  dialog,
  session as electronSession,
  webContents as electronWebContents,
  ipcMain,
  systemPreferences,
  type WebContents,
} from "electron";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import type { PluginSandboxRecord, PluginSandboxRegistryPort } from "./contract.js";
import { attachPluginSandboxGuest, configurePluginSandboxGuest } from "./guestPolicy.js";
import { createPluginSandboxPermissionGate } from "./permissionGate.js";
import { formatPluginSandboxPermissionDialogText } from "./permissions.js";
import type { PluginSandboxAssetSource } from "./protocol.js";
import { createPluginSandboxRegistry } from "./registry.js";
import { preparePluginSandboxSession } from "./session.js";
import { sandboxCaptureSchema, scaleCaptureRect } from "./capture.js";
import { DesktopBrowserScreenshotActivityController } from "@desktop/main/browserView/browserScreenshotActivityController.js";

export interface PluginSandboxHost {
  clearBrowserData(): Promise<void>;
  /** host 进程经 parentPort 登记；返回句柄前完成 partition session 准备。 */
  registerFromHost(input: PluginSandboxRegisterInput): PluginSandboxHandle;
  /** desktopWindowChrome 的 will-attach 分支。 */
  configureGuest(input: {
    webPreferences: Electron.WebPreferences;
    params: Record<string, string>;
    ownerWebContentsId: number;
  }): ReturnType<typeof configurePluginSandboxGuest>;
  /** desktopWindowChrome 的 did-attach 分支。 */
  attachGuest(input: { guest: WebContents; hostWebContents: WebContents; sandboxId: string }): void;
}

// [权衡] 模块级单例而非依赖注入：Electron 的 IPC channel 按名字全局唯一，
// 同名二次注册会直接抛错，所以安装入口必须幂等，不能按窗口各装一份。
// [并发] app ready 后由主线程单线程调用，getPluginSandboxHost 只读引用，无需加锁；
// 若将来出现并发安装，必须先占位再初始化，否则会造出两套 registry 与两套窗口监听。
// 该变量为空表示宿主能力尚未安装，调用方据此放弃注册插件沙箱而不是抛错。
// [失败路径] 安装过程抛错时不会写回该变量，下次调用会重跑全部流程，
// 因此登记型副作用必须排在最后赋值之前，避免半安装状态被当成已安装复用。
// 单例还承担「跨窗口共享同一个活动控制器」的职责，窗口级实例会让租约互相看不见。
let installedHost: PluginSandboxHost | null = null;

export function getPluginSandboxHost(): PluginSandboxHost | null {
  return installedHost;
}

/**
 * 在 app ready 后安装一次：创建注册表、注册 renderer 可调的两条 IPC（dispose / 手势消费，按 sender 归属校验）。
 * scheme 的 privileged 注册必须在 app ready 前、与 zcode-media 同一次调用完成，不在这里。
 */
export function installPluginSandboxHost(input: {
  preloadPath: string;
  rendererDir: string;
  aliasDir: string;
  /** vite dev server 地址；有值时 shell 资源从它代理（见 PluginSandboxAssetSource）。 */
  devServerUrl?: string;
  logger?: { warn: (...args: unknown[]) => void; info?: (...args: unknown[]) => void };
  registry?: PluginSandboxRegistryPort;
  /** 注册表容量（缺省 64）；e2e L05 用 1 验证配额拒绝。 */
  registryMaxEntries?: number;
}): PluginSandboxHost {
  if (installedHost) return installedHost;
  // [资源] 下面几个容器都以 sandboxId 或 webContents id 为键，生命周期与 host 同长：
  // 窗口关闭时不能清空它们，否则迟到的 did-attach 会重建出没有归属的登记。
  // detachByKey 保存 attachPluginSandboxGuest 返回的拆除函数，重复 attach 必须先调旧值；
  // 漏调会让旧 MessagePort 继续挂在通道上，同一 sandboxId 出现两条消息链路。
  // guests 只记录当前 guest，覆盖写是刻意的：旧对象由 destroyed 事件回收。
  // watchedOwners 是防重复挂 destroyed 监听的去重集，不是资源表，删条目只代表监听已触发。
  // executions 保存活动租约，缺键等价于「该沙箱当前不应推进画面」。
  // [权衡] 若换用 WeakMap，destroyed 回调里拿不到已销毁对象的键，所以无法清理。
  const detachByKey = new Map<string, () => void>();
  const watchedOwners = new Set<number>();
  const guests = new Map<string, WebContents>();
  const activity = new DesktopBrowserScreenshotActivityController({
    fromId: (id) => BrowserWindow.fromId(id),
    fromWebContentsId: (id) => electronWebContents.fromId(id) ?? null,
    log: (message) => input.logger?.warn(message),
  });
  const executions = new Map<string, { lease?: ReturnType<typeof activity.acquire> }>();
  const releaseExecution = (sandboxId: string) => {
    executions.get(sandboxId)?.lease?.release();
    executions.delete(sandboxId);
  };
  // [并发] 这里有三个触发源：did-stop-loading、IPC 激活、租约失效，
  // 因此每步都要重新读状态，不能把守卫条件交给调用方判断。
  // 守卫缺一不可：无登记表示沙箱已释放；已有租约表示重复请求；无 guest 或已销毁
  // 表示窗口正在关闭；仍在加载主框架表示画面未就绪，此时租约会被紧随的导航打断。
  // [权衡] 队列重试被刻意放弃，改为等 did-stop-loading 再来一次：排队会持有旧 guest 引用，
  // 一旦期间发生换代，重试就会给已废弃页面续租，把错误状态固化下来。
  // [失败路径] 找不到宿主窗口时直接返回而不抛错：窗口已销毁是正常竞态，
  // 抛错只会让调用方收到一个无法处理的异常。
  const syncExecution = (sandboxId: string) => {
    const state = executions.get(sandboxId);
    const guest = guests.get(sandboxId);
    if (!state || state.lease || !guest || guest.isDestroyed() || guest.isLoadingMainFrame())
      return;
    const owner = guest.hostWebContents;
    const win = owner && BrowserWindow.fromWebContents(owner);
    if (!win) return;
    state.lease = activity.acquire({
      windowId: win.id,
      webContentsId: guest.id,
      requestId: sandboxId,
      reason: "plugin-execution",
    });
    // 隐藏页面仅需低频推进；不能全局关闭 backgroundThrottling，否则同窗空闲 guest 也会跑帧。
    state.lease?.markPrepared?.();
    state.lease?.invalidated?.addEventListener(
      "abort",
      () => {
        if (executions.get(sandboxId) === state) releaseExecution(sandboxId);
      },
      { once: true },
    );
  };
  const stopping = new WeakMap<WebContents, Promise<void>>();
  const partitions = new Set<string>();
  let clearing = false;
  const assets: PluginSandboxAssetSource = {
    rendererDir: input.rendererDir,
    aliasDir: input.aliasDir,
    ...(input.devServerUrl ? { devServerUrl: input.devServerUrl } : {}),
  };
  // [资源] 停止顺序固定为「导航到 about:blank → 关闭包装对象 → 等待 destroyed」，
  // 三步都不能省：只 close 时 attached guest 仅销毁包装对象，
  // iframe 仍能继续写同一 partition 的存储，用户点关闭后数据仍在增长。
  // [失败路径] will-prevent-unload 必须在停止期间临时拦截，否则页面里的 beforeunload
  // 可以永久阻止导航，清理流程会挂在这里等一个永不到来的事件。
  // 导航被中止属于预期：renderer 已移除 webview 或宿主窗口关闭时实际文档已释放，
  // 只有 guest 仍存活才算真正错误，需要继续向上传播。
  // 同一 guest 的并发调用复用 stopping 里的 Promise，保证 close 只发一次。
  const stopGuest = (guest: WebContents): Promise<void> => {
    if (guest.isDestroyed()) return Promise.resolve();
    const existing = stopping.get(guest);
    if (existing) return existing;
    // Electron 41 的 attached guest.close 只销毁包装对象，iframe 仍可写存储。
    // 先完成原生空白页导航，真正移除旧文档；不用 destroyed 或延时猜测页面已经停止。
    const stopped = Promise.resolve().then(async () => {
      if (guest.isDestroyed()) return;
      const allowUnload = (event: Electron.Event) => event.preventDefault();
      guest.on("will-prevent-unload", allowUnload);
      try {
        await guest.loadURL("about:blank");
      } catch (error) {
        // Renderer 移除 webview / owner 关闭时会中止导航，此时实际文档已释放。
        if (!guest.isDestroyed()) throw error;
      } finally {
        guest.removeListener("will-prevent-unload", allowUnload);
      }
      if (guest.isDestroyed()) return;
      const destroyed = new Promise<void>((resolve) => guest.once("destroyed", resolve));
      guest.close({ waitForBeforeUnload: false });
      await destroyed;
    });
    stopping.set(guest, stopped);
    return stopped;
  };
  // partition 持久且按可信 App 身份隔离：dispose 关闭 guest 和端口，
  // 不撤 protocol handler、不清存储；存储清理走已有清除所有数据入口。
  // [资源] 释放顺序：先撤活动租约，再拆消息通道，最后异步停止 guest。
  // 顺序反了会让租约在 guest 销毁后仍持有窗口 id，控制器按已失效 id 记账。
  // [事务] registry 的 dispose 回调与 IPC 的 dispose 请求可能同时到达，
  // 两个入口都只做幂等动作，重复执行不会停掉仍有效的登记。
  // guest 必须保留到真正停止之后才从表里移除：清除浏览器数据要能等待
  // 已经进入 dispose 的旧实例，提前删表会让清理与残留写入并发。
  // [失败路径] 停止失败只记 warn 不抛错：调用点多为事件回调，抛错会中断后续释放。
  // partition 与协议处理器刻意不在这里撤销，见上方关于持久 partition 的说明。
  const onDispose = (record: PluginSandboxRecord) => {
    releaseExecution(record.sandboxId);
    detachByKey.get(record.sandboxId)?.();
    detachByKey.delete(record.sandboxId);
    const guest = guests.get(record.sandboxId);
    // 保留 guest 到真正停止：清除数据必须能等待已经进入 dispose 的旧实例。
    if (guest)
      void stopGuest(guest).catch((error: unknown) =>
        input.logger?.warn("[plugin-sandbox] guest stop failed", String(error)),
      );
  };
  const registry =
    input.registry ??
    createPluginSandboxRegistry({
      onDispose,
      ...(input.registryMaxEntries !== undefined ? { maxEntries: input.registryMaxEntries } : {}),
    });

  // 页面浏览器权限闸门：确认框由 main 原生弹出，父窗口是登记该沙箱的宿主窗口，页面无法伪造。
  const resolveLocale = (): Locale =>
    app.getLocale().toLowerCase().startsWith("zh") ? "zh-CN" : "en-US";
  const permissions = createPluginSandboxPermissionGate({
    registry,
    async prompt({ record, permissions: pending }) {
      const text = formatPluginSandboxPermissionDialogText(
        { serverName: record.serverName ?? "ZCode Gen UI", permissions: pending },
        resolveLocale(),
      );
      const owner = electronWebContents.fromId(record.ownerWebContentsId);
      const parent = owner ? BrowserWindow.fromWebContents(owner) : null;
      const options = {
        type: "question" as const,
        buttons: [text.allowButton, text.denyButton],
        defaultId: 1,
        cancelId: 1,
        title: text.title,
        message: text.message,
        detail: text.detail,
        noLink: true,
      };
      const { response } =
        parent && !parent.isDestroyed()
          ? await dialog.showMessageBox(parent, options)
          : await dialog.showMessageBox(options);
      return response === 0;
    },
    ...(process.platform === "darwin"
      ? {
          async requestSystemMediaAccess(kind: "camera" | "microphone") {
            const status = systemPreferences.getMediaAccessStatus(kind);
            if (status === "granted") return true;
            if (status !== "not-determined") return false;
            return systemPreferences.askForMediaAccess(kind);
          },
        }
      : {}),
    ...(input.logger ? { logger: input.logger } : {}),
  });

  const host: PluginSandboxHost = {
    async clearBrowserData() {
      clearing = true;
      for (const owner of watchedOwners) registry.disposeOwner(owner);
      await Promise.all([...guests.values()].map(stopGuest));
      guests.clear();
      const names = await readdir(join(app.getPath("sessionData"), "Partitions")).catch(
        (error: NodeJS.ErrnoException) => {
          if (error.code === "ENOENT") return [];
          throw error;
        },
      );
      for (const name of names)
        if (/^plugin-sandbox-v[12]-[a-f0-9]+$/.test(name)) partitions.add(`persist:${name}`);
      await Promise.all(
        [...partitions].map(async (partition) => {
          const session = electronSession.fromPartition(partition);
          await session.clearStorageData();
          await session.clearCache();
        }),
      );
    },
    // [事务] 登记顺序：校验窗口存活 → 写 registry → 记录 partition → 挂窗口监听 → 准备 session。
    // session 准备排在最后且失败会向上抛，此时 registry 里已有记录，由调用方
    // 的错误处理触发 dispose，所以这里不能吞掉异常。
    // [资源] owner 的 destroyed 监听与 attachGuest 共用 watchedOwners 去重，
    // 两个入口都可能先到：prepare 完成但未挂载的登记同样要随窗口关闭被释放。
    // [失败路径] clearing 期间直接拒绝新登记而不是排队：清理完成后旧窗口往往已不存在，
    // 排队只会让一次必然失败的登记延迟暴露，还占着调用方的时间片。
    registerFromHost(registerInput) {
      if (clearing) throw new Error("MCP App browser data is being cleared");
      const owner = electronWebContents.fromId(registerInput.ownerWebContentsId);
      if (!owner || owner.isDestroyed()) throw new Error("MCP App window is no longer available");
      const handle = registry.register(registerInput);
      partitions.add(handle.partition);
      // prepare 后尚未挂载的登记也属于窗口；关闭和清除数据不能漏掉它们。
      if (!watchedOwners.has(owner.id)) {
        watchedOwners.add(owner.id);
        owner.once("destroyed", () => {
          watchedOwners.delete(owner.id);
          registry.disposeOwner(owner.id);
        });
      }
      preparePluginSandboxSession({
        session: electronSession.fromPartition(handle.partition),
        registry,
        assets,
        permissions,
        logger: input.logger,
      });
      // 每个沙箱登记一次一条，供排 renderer / host / main 三段握手用。
      input.logger?.info?.("[plugin-sandbox] registered", {
        sandboxId: handle.sandboxId,
        initId: handle.initId,
        scopeId: registerInput.scopeId,
        ownerWebContentsId: registerInput.ownerWebContentsId,
      });
      return handle;
    },
    configureGuest(guestInput) {
      return configurePluginSandboxGuest({
        ...guestInput,
        registry,
        preloadPath: input.preloadPath,
      });
    },
    attachGuest({ guest, hostWebContents, sandboxId }) {
      if (clearing) {
        void stopGuest(guest).catch((error: unknown) =>
          input.logger?.warn("[plugin-sandbox] late guest stop failed", String(error)),
        );
        return;
      }
      guests.set(sandboxId, guest);
      // dom-ready / did-finish-load 回调时仍可能处于 loading，早到的活动请求会被上面的守卫跳过。
      // 以真正停止加载的事件承接待处理请求，不能依赖插件或 session 再发一次活动请求。
      guest.on("did-stop-loading", () => syncExecution(sandboxId));
      guest.once("destroyed", () => {
        if (guests.get(sandboxId) === guest) {
          releaseExecution(sandboxId);
          guests.delete(sandboxId);
        }
      });
      // H14：宿主 webContents 销毁（窗口关闭 / 崩溃）时释放它名下全部登记；每个 owner 只挂一次。
      if (!watchedOwners.has(hostWebContents.id)) {
        watchedOwners.add(hostWebContents.id);
        const ownerId = hostWebContents.id;
        hostWebContents.once("destroyed", () => {
          watchedOwners.delete(ownerId);
          registry.disposeOwner(ownerId);
        });
      }
      detachByKey.get(sandboxId)?.();
      detachByKey.set(
        sandboxId,
        attachPluginSandboxGuest({
          guest,
          hostWebContents,
          registry,
          sandboxId,
          createMessageChannel: () => new MessageChannelMain(),
          logger: input.logger,
        }),
      );
    },
  };

  // [并发] 下面几个 handler 全由 renderer 触发，sender 身份是唯一可信的归属来源，
  // 任何从参数里读 owner 的写法都等于让页面自证身份。
  // [失败路径] 类型不符的入参一律抛错而不是强转：IPC 边界没有编译期约束，
  // 静默强转会把 undefined 变成合法 sandboxId，命中别的沙箱记录。
  // 未知 sandboxId 与归属不符的 sender 分开处理：前者抛错暴露调用时序问题，
  // 后者静默忽略，避免把「谁登记了哪个沙箱」泄露给无关窗口。
  // 消息通道由 attachPluginSandboxGuest 内部建立的 MessagePort 承载，
  // 不在这里开放通用转发入口，新增消息类型必须先登记到白名单。
  ipcMain.handle(PlatformChannels.PluginSandboxOwnerWebContentsId, (event) => event.sender.id);
  ipcMain.handle(
    PlatformChannels.PluginSandboxExecutionActive,
    (event, sandboxId: unknown, initId: unknown, active: unknown) => {
      if (
        typeof sandboxId !== "string" ||
        typeof initId !== "number" ||
        typeof active !== "boolean"
      )
        throw new Error("Invalid sandbox execution request");
      const record = registry.get(sandboxId);
      if (
        !record ||
        record.ownerWebContentsId !== event.sender.id ||
        record.initId !== initId ||
        record.contentKind === "gen-ui"
      )
        throw new Error("Sandbox execution is no longer available");
      if (!active) {
        releaseExecution(sandboxId);
        return;
      }
      if (!executions.has(sandboxId)) executions.set(sandboxId, {});
      syncExecution(sandboxId);
    },
  );
  // [并发] 截图是异步的，所以 await 之后页面可能已销毁或换代为新的 initId，
  // 因此 isCurrent 必须连 registry 中的记录身份一起比较，而不只看 id 相等。
  // [失败路径] 两次校验抛同一个错误：调用方只需按「已失效」处理，
  // CopyImage 无需区分是开始前失效还是 await 过程中失效，两种情况都按已失效处理。
  // 裁剪比例按截图实际尺寸换算，页面在两次读取之间改变视口会得到错误区域，
  // 这是可接受的权衡：重新截图会放大竞态窗口，而用户看到的本就是瞬时画面。
  // [资源] 位图重建只在 win32 分支需要，其他平台直接传图以减少一次拷贝。
  ipcMain.handle(PlatformChannels.PluginSandboxCopyImage, async (event, value: unknown) => {
    const request = sandboxCaptureSchema.parse(value);
    const record = registry.get(request.sandboxId);
    const guest = guests.get(request.sandboxId);
    const isCurrent = () =>
      record &&
      registry.get(request.sandboxId) === record &&
      record.ownerWebContentsId === event.sender.id &&
      record.initId === request.initId &&
      !event.sender.isDestroyed() &&
      guest &&
      !guest.isDestroyed() &&
      guests.get(request.sandboxId) === guest;
    if (!isCurrent() || !guest) throw new Error("Sandbox capture is no longer available");
    const captured = await guest.capturePage();
    // 截图期间页面可能释放或换代；旧请求不得把错误页面的图像写入剪贴板。
    if (!isCurrent()) throw new Error("Sandbox capture is no longer available");
    const cropped = captured.crop(scaleCaptureRect(request, captured.getSize()));
    clipboard.writeImage(
      process.platform === "win32"
        ? nativeImage.createFromBitmap(cropped.toBitmap(), cropped.getSize())
        : cropped,
    );
  });
  ipcMain.handle(
    PlatformChannels.PluginSandboxDispose,
    (event, sandboxId: unknown, initId: unknown) => {
      if (typeof sandboxId !== "string") return;
      const record = registry.get(sandboxId);
      // 只有登记时的宿主窗口能释放自己的沙箱；其他 sender 静默忽略。
      if (!record || record.ownerWebContentsId !== event.sender.id) return;
      input.logger?.info?.("[plugin-sandbox] dispose requested", {
        sandboxId,
        initId,
        currentInitId: record.initId,
      });
      registry.dispose(sandboxId, typeof initId === "number" ? initId : undefined);
      const guest = guests.get(sandboxId);
      // 旧 initId 的迟到 dispose 不能停止仍有效的登记。
      if (guest && !registry.get(sandboxId)) return stopGuest(guest);
    },
  );
  ipcMain.handle(PlatformChannels.PluginSandboxConsumeUserGesture, (event, sandboxId: unknown) => {
    if (typeof sandboxId !== "string") return false;
    const record = registry.get(sandboxId);
    if (!record || record.ownerWebContentsId !== event.sender.id) return false;
    return registry.consumeUserGesture(sandboxId);
  });

  installedHost = host;
  return host;
}
