// INV-01 一个窗口恰好拥有一个 Local Host，映射键固定为 webContents.id（wcId），绝不使用 win.id；守住位置：createWindow 的 wcId 与 windowHostProcessMap；改错故障：closed 时按错键取不到 host，utility process 沦为孤儿常驻后台，再开窗口时 CPU 与内存翻倍
// INV-02 窗口侧全部资源的唯一释放点是 win 的 closed 事件，顺序固定为注销遥测、取消预热等待、处置 Host、删除映射、释放远控窗口、释放会话绑定；守住位置：win.on("closed") 处理器；改错故障：先删映射再取 Host 只能取到 undefined，CLI 子进程永久泄漏，注销后应用仍占着远端会话端口
// INV-03 renderer reload 只补挂端口、不重建 Host，补挂成功后必须在 try 内立即返回，不得落到下方的 dispose 与 spawn；守住位置：dom-ready 的 oldChild 分支；改错故障：一次手动刷新就生成第二个 Host，两进程抢同一 workspace 锁，会话历史被交错写入
// INV-04 dom-ready 的异步续体只允许最新一代生效，创建前须比对 domReadyGeneration 并确认窗口未销毁；守住位置：spawnLocalHost 首段守卫；改错故障：连续两次 reload 时旧续体把死 Host 写进映射，界面显示已连接而请求全部无响应
// INV-05 windowHostProcessMap 必须先写入新 Host、再触发 onHostProcessReady，顺序不可颠倒；守住位置：spawnLocalHost 尾部；改错故障：呈现层回放时按 wcId 查不到 Host，更新提示与状态面板整段丢失，直到下次 reload 才恢复
// INV-06 环境预热等待是一次性博弈，settled 置真后超时回调与 promise 回调只能有一个继续；守住位置：completeWait 与 setTimeout 分支；改错故障：同一次 dom-ready 建出两个 Host，后者覆盖映射，前者无人回收
// INV-07 预热超时或失败一律 fail-open，必须用预计算的 fallback patch 建 Host，绝不因环境采集卡住启动；守住位置：超时回调与 rejection 分支；改错故障：首屏等不到 Local Host，用户长时间白屏后才被判成启动失败
// INV-08 macOS 关闭全部窗口不退出应用，darwin、forceQuit、非最后窗口三种情况都必须放行关闭；守住位置：handleDesktopWindowCloseRequest 的这条早返回；改错故障：Cmd+W 被吞掉关不掉窗口，或反过来 Windows 上最后一个窗口关闭后进程滞留，用户再启动时看不到任何窗口
// INV-09 只有「最后窗口、非 forceQuit、非 darwin」才进入退出确认，用户取消确认时仍须拦截关闭；守住位置：close 监听与 handleDesktopWindowCloseRequest 的返回值；改错故障：用户点了取消窗口照旧关闭，未保存的编辑直接丢失
// INV-10 托盘隐藏分支要求 closeToTraySupported 严格等于 true，缺省按不可用处理；守住位置：canHideToTray 的严格比较；改错故障：GNOME 等无托盘环境下窗口被隐藏且无入口唤回，应用看似卡死只能强杀
// INV-11 关闭请求返回 true 表示「已处理、不要关窗」，调用方必须据此 preventDefault；守住位置：两处 close 监听的 if 分支；改错故障：窗口既被隐藏又被销毁，托盘图标点击后无窗口可显示
// INV-12 非 darwin 平台的关闭行为只由注入的 handleBeforeClose 决定，本文件不自行判断退出；守住位置：else if (options.handleBeforeClose) 分支；改错故障：两套退出逻辑同时生效，确认弹窗出现两次或互相取消
// INV-13 窗口尺寸持久化必须在窗口创建后立即挂载，早于任何 dom-ready 与 Host 启动；守住位置：persistWindowSize 分支；改错故障：用户在 Host 起来前拖动窗口，尺寸变更不被监听，下次启动回到旧尺寸
// INV-14 尺寸写盘失败只降级为 warn，不得抛给 Electron 事件循环；守住位置：attachDesktopWindowSizePersistence 的错误回调；改错故障：磁盘满时抛出的异常打断关闭流程，窗口关不掉
// INV-15 win32 的 dom-ready 必须显式 show 与 focus，其它平台不做这两步；守住位置：dom-ready 首段的平台判断；改错故障：Windows 上窗口停在后台不可见，用户以为启动失败，或反过来在 macOS 上抢走正在使用的外应用焦点
// INV-16 win.webContents 上的 dom-ready 与 win 上的 close、closed 监听随对象销毁自动解绑，本文件不手动 removeListener，也不把监听挂到长生命周期的 app 上；守住位置：全部事件注册点；改错故障：监听残留在已销毁的 webContents 上，下一次 dom-ready 触发旧闭包并操作死窗口
// INV-17 已销毁或取不到的窗口必须从 windowWorkspaceMap 中剔除，不得留在表内；守住位置：focusWorkspaceInExistingWindow 的删除分支；改错故障：失效 winId 持续命中，点击侧栏路径永远激活失败，该 workspace 再也打不开
// INV-18 复用已有窗口时按 winId 精确取 BrowserWindow，命中后顺序必须固定为 restore、focus、发送 FocusTab；守住位置：focusWorkspaceInExistingWindow 的命中分支；改错故障：最小化窗口只 focus 不 restore，界面毫无变化，用户重复点击以为失灵
// INV-19 未读角标取所有窗口的最大值而非求和，计数归零时必须从映射删除；守住位置：syncApplicationUnreadBadge 与 handleWindowUnreadCountSync；改错故障：三扇窗各 1 条未读被显示成 3，角标虚高后用户找不到对应消息
// INV-20 任务栏 overlay 的像素布局在模块加载时按平台版本定型一次，运行期不再重算；守住位置：windowsTaskbarOverlayLayout 常量；改错故障：每扇窗口重新探测系统版本导致角标闪烁，或在 Win10 上套用 Win11 圆角布局，图标边缘出现缺口
import { getDatabaseStartupPortPayload } from "./databaseStartupRelay.js";
import { randomUUID } from "node:crypto";
import { release as readPlatformRelease } from "node:os";
import { app, BrowserWindow, Menu, MessageChannelMain, nativeImage } from "electron";
import type { UtilityProcess as ElectronUtilityProcess } from "electron";
import { HostMessageTypes, InternalChannels, PlatformChannels, type Locale } from "@zcode/shared";
import { scheduleArmsBrowserPerfLoadNudge } from "./armsBrowserPerfLoadNudge.js";
import { createBrowserWindow } from "./desktopWindowChrome.js";
import type { HostInitMessage, WindowBootstrapOptions } from "./desktopHostProcess.js";
import type { StartupWorkspaceWarmupTarget } from "./startupWorkspace.js";
import type { RemoteAssetDirs } from "./desktopRuntimeEnv.js";
import { handleDarwinWindowCloseRequest } from "./desktopDarwinCloseBehavior.js";
import { supportsNativeWindowsRoundedCorners } from "./desktopWindowChromeState.js";
import { applyDesktopTrayUnreadBadge } from "./desktopTray.js";
import {
  createWindowsTaskbarOverlayApplier,
  maxWindowUnreadCounts,
  parseWindowUnreadCount,
  renderTaskbarStatusDotPixels,
  syncUnreadBadgeForPlatform,
} from "./unreadBadge.js";
import { attachDesktopWindowSizePersistence, type DesktopWindowSize } from "./desktopWindowSize.js";
import {
  registerMainApplicationWindow,
  unregisterMainApplicationWindow,
} from "./resourceManagerWindow.js";

const DEFAULT_RUNTIME_PROCESS_ENV_WAIT_TIMEOUT_MS = 4_500;

export function createWindow(options: {
  iconPath: string;
  preloadPath: string;
  logger: { info: (...args: unknown[]) => void; warn: (...args: unknown[]) => void };
  forceQuitRef: { current: boolean };
  handleBeforeClose?: (win: BrowserWindow, label: string) => boolean;
  windowHostProcessMap: Map<number, ElectronUtilityProcess>;
  spawnHostProcess: (
    win: BrowserWindow,
    label: string,
    // Main 在包装层统一注入 zcodeBuiltinProviderConfigFilePath（Electron 安装布局只有 Main 知道），
    // 窗口生命周期只负责组装其余 InitLocal 字段。
    initMessage: Omit<HostInitMessage, "zcodeBuiltinProviderConfigFilePath">,
  ) => ElectronUtilityProcess;
  disposeHostProcess: (
    child: ElectronUtilityProcess,
    label: string,
    forceKillDelayMs?: number,
  ) => void;
  syncAutoUpdaterStateToWindow: (win: BrowserWindow) => void;
  syncReadyUpdateToWindow: (win: BrowserWindow) => void;
  syncPostUpdateReleaseNotesToWindow: (win: BrowserWindow) => void;
  webRemoteControlManager: { disposeWindow(windowId: number): Promise<void> };
  disposeRemoteWorkspaceSessionsForWindow: (windowId: number, reason: string) => void;
  reattachRemoteWorkspaceSessionsForWindow: (win: BrowserWindow, reason: string) => void;
  bootstrap?: WindowBootstrapOptions;
  agentWarmupTargets?: readonly StartupWorkspaceWarmupTarget[];
  agentSpawnFallbackCwd: string;
  deviceMid: string;
  remoteAssets?: RemoteAssetDirs;
  initialDesktopZoomLevel?: number;
  initialWindowSize?: DesktopWindowSize;
  currentApplicationLocale?: () => Locale;
  persistWindowSize?: (state: DesktopWindowSize) => Promise<void>;
  /** Main 模块初始化期已开始的异步环境采集；通常在 renderer dom-ready 前完成。 */
  runtimeProcessEnvPatchPromise?: Promise<Record<string, string>>;
  /** 不执行 shell 即可计算的完整降级 patch；预热失败/超时时仍要注入 Local Host。 */
  runtimeProcessEnvFallbackPatch: Record<string, string>;
  /** 仅供启动门禁和测试注入；超过该时间必须 fail-open 创建 Local Host。 */
  runtimeProcessEnvWaitTimeoutMs?: number;
  /**
   * 首个 Local Host 创建前的有界灰度裁决门。
   *
   * 缺省（undefined）时完全不触发 await，dom-ready handler 同步执行——保证既有调用方
   * 与测试零回归。仅 desktop main 注入：在 spawnLocalHost 之前等待一次 rollout 裁决，
   * 避免冷启动快照 { enabled:false } 被烤进首 Host env 后无法被异步成功结果覆盖。
   */
  awaitFirstHostSpawnDecision?: () => Promise<void>;
  /** Local Host map insertion completed; presentation facts can now be replayed safely. */
  onHostProcessReady?: (windowKey: number) => void;
  resolveBrowserViewOwner?: Parameters<typeof createBrowserWindow>[0]["resolveBrowserViewOwner"];
}) {
  const win = createBrowserWindow({
    iconPath: options.iconPath,
    preloadPath: options.preloadPath,
    bootstrap: {
      restoreSession: options.bootstrap?.restoreSession ?? true,
      supportsSettings: options.bootstrap?.supportsSettings ?? true,
      initialWorkspacePath: options.bootstrap?.initialWorkspacePath,
      initialWorkspacePurpose: options.bootstrap?.initialWorkspacePurpose,
      unavailableWorkspacePath: options.bootstrap?.unavailableWorkspacePath,
    },
    logger: options.logger,
    deviceMid: options.deviceMid,
    initialDesktopZoomLevel: options.initialDesktopZoomLevel,
    initialWindowSize: options.initialWindowSize,
    currentApplicationLocale: options.currentApplicationLocale,
    resolveBrowserViewOwner: options.resolveBrowserViewOwner,
  });
  const label = `local-${win.webContents.id}`;

  // 尺寸持久化必须早于任何 dom-ready 与 Host 启动，挂载后用户第一次拖动就已经被计入
  // [资源] 监听器必须挂在 win 上，随窗口销毁一并回收，本文件不保留句柄也不需要显式解绑
  // 持久化回调由调用方注入，本文件只决定 attach 的挂载时机，不决定落盘格式与节流策略
  // [失败路径] 写盘失败只降级成 warn，不得上抛，抛错会穿透关闭流程让窗口关不掉
  // 未注入 persistWindowSize 时整段跳过，无头窗口与测试窗口因此不必伪造存储
  // [权衡] 这里不做防抖：节流属于注入方实现，多叠一层会让两套持久化策略互相打架
  // 该分支位于 createWindow 顶部，保证后续任何早退路径都带着尺寸跟踪
  if (options.persistWindowSize) {
    attachDesktopWindowSizePersistence(win, options.persistWindowSize, (error) => {
      options.logger.warn("[desktop-window] failed to persist main window size", error);
    });
  }

  if (process.platform === "darwin") {
    win.on("close", (event) => {
      if (
        handleDarwinWindowCloseRequest({
          win,
          // darwin 的关闭语义全部委托给 handleDarwinWindowCloseRequest，本文件只把返回值翻译成 preventDefault
          // 返回 true 表示已拦截，此时必须拦截默认行为，否则窗口照常销毁而托盘与 Host 仍在
          // [并发] forceQuit 在每次关闭时现读 ref，不在注册时快照，退出流程会在窗口存活期间改写真值
          // 用 ref 而不是布尔：监听器在 createWindow 期间注册，之后无法替换闭包捕获的标量
          // label 用于日志对位，同一进程多窗口时靠它区分是哪一扇被关闭
          // [权衡] 不在此处判断是否最后窗口：该判断需要窗口清单，交给 handleDesktopWindowCloseRequest 统一裁决
          // 非 darwin 平台必须不进这段，改走注入的 handleBeforeClose，两条路径互不重叠
          forceQuit: options.forceQuitRef.current,
          label,
          logger: options.logger,
        })
      ) {
        event.preventDefault();
      }
    });
  } else if (options.handleBeforeClose) {
    win.on("close", (event) => {
      if (options.handleBeforeClose?.(win, label)) {
        event.preventDefault();
      }
    });
  }

  const wcId = win.webContents.id;
  const browserWindowId = win.id;
  // 资源遥测据此把主窗口 renderer 归 renderer_main；辅助窗口与 DevTools 归 chromium_other。
  registerMainApplicationWindow(wcId);
  let domReadyGeneration = 0;
  let cancelRuntimeProcessEnvWait: (() => void) | null = null;
  scheduleArmsBrowserPerfLoadNudge(win.webContents);
  win.webContents.on("dom-ready", async () => {
    cancelRuntimeProcessEnvWait?.();
    cancelRuntimeProcessEnvWait = null;
    const currentDomReadyGeneration = ++domReadyGeneration;
    options.logger.info(`[createWindow] dom-ready fired (${label})`);

    if (process.platform === "win32" && !win.isDestroyed()) {
      win.show();
      win.focus();
    }

    const oldChild = options.windowHostProcessMap.get(wcId);
    // renderer 刷新（reload）
    // 曾经无条件杀掉旧 host 进程再重建——host 连带 CLI agent 一起死，运行中的会话直接消失，
    // 这正是「会话身份易失」病根。host/CLI 的生命周期属于窗口而非
    // renderer 加载周期：reload 只需给存活的 host 补挂一条新 RPC MessagePort
    // （复用 web 远控的 AttachServicePort 通道），renderer 重新订阅即可恢复投影。
    // 旧端口的 ChannelServer 会随 renderer 上下文销毁触发 close 自行回收。
    // 命中该分支说明 renderer 只是重新加载，窗口与 Host 都还活着，必须补挂而不是重建
    // pid 是 Host 存活的唯一证据，拿不到 pid 的条目必须按已死处理，继续向下走重新创建
    // [资源] 新建一对 MessageChannelMain 端口，一条交 Host、一条交 renderer，都必须随消息一并转移
    // 启动绑定缺失时抛错而不是硬发端口，没有启动绑定的 Host 收不到附件，后续请求会全部超时
    // 补挂成功后仍要重放更新状态与远控会话，否则界面停留在刷新前的旧快照
    // [失败路径] 任一环节抛错都必须落到 catch 走重新创建，绝不允许半挂状态，半挂比重启更难诊断
    // 此处返回是硬约束，不返回会继续执行下方的处置与创建，等于自己杀掉刚补挂的 Host
    if (oldChild && oldChild.pid !== undefined) {
      try {
        const startupPayload = getDatabaseStartupPortPayload(oldChild);
        if (!startupPayload) throw new Error("Previous Host startup binding is unavailable");
        const { port1, port2 } = new MessageChannelMain();
        oldChild.postMessage(
          {
            type: HostMessageTypes.AttachServicePort,
            requestId: randomUUID(),
            attachmentId: randomUUID(),
            clientMode: "desktop-continuous",
            scope: { kind: "local" },
          },
          [port2],
        );
        win.webContents.postMessage(InternalChannels.ServicePort, startupPayload, [port1]);
        options.logger.info(
          `[createWindow] renderer reloaded, reattached to existing host (${label}), pid=${oldChild.pid}`,
        );
        options.syncAutoUpdaterStateToWindow(win);
        options.syncReadyUpdateToWindow(win);
        options.syncPostUpdateReleaseNotesToWindow(win);
        options.reattachRemoteWorkspaceSessionsForWindow(win, `${label}:renderer-reload`);
        return;
      } catch (error) {
        options.logger.warn(
          `[createWindow] reattach to existing host failed (${label}), falling back to respawn:`,
          error,
        );
      }
    }
    if (oldChild) {
      options.logger.info(
        `[createWindow] killing previous host process for (${label}), pid=${oldChild.pid ?? "unknown"}`,
      );
      options.disposeHostProcess(oldChild, `${label}:reload`, 150);
    }

    // 首个 Local Host 创建前的有界灰度裁决门。用 `if` 守卫而非 `await cb?.()`——
    // cb 缺省时不触发任何 await，async handler 同步跑完，保证既有调用方与测试零回归。
    // 仅在需要 spawn 新 Host 的路径上等待（reattach 早退路径已在上方 return，不触发）。
    if (options.awaitFirstHostSpawnDecision) {
      await options.awaitFirstHostSpawnDecision();
    }

    // 本函数是唯一的 Host 创建出口，环境预热的各条路径最终都收敛到这里
    // 首段守卫同时校验代际与销毁态，二者缺一都会把死进程写进映射
    // [并发] 代际号只在 dom-ready 自增，异步等待期间若发生新一次刷新，旧续体必须自我作废
    // 丢弃续体时不做任何清理，新一次 dom-ready 会自己接管映射与等待器
    // patch 由调用方传入而不是在函数内取，超时与失败分支才能共用同一份预计算结果
    // [权衡] 不在函数内做重试：一次 dom-ready 只允许一个 Host，重试会与代际守卫的语义直接冲突
    // 创建完成后紧接着同步更新状态与会话，保证首帧就能拿到正确的版本提示
    const spawnLocalHost = (runtimeProcessEnvPatch: Record<string, string>) => {
      if (currentDomReadyGeneration !== domReadyGeneration || win.isDestroyed()) {
        return;
      }
      const primaryWarmupTarget = options.agentWarmupTargets?.[0];
      const child = options.spawnHostProcess(win, label, {
        type: HostMessageTypes.InitLocal,
        deviceMid: options.deviceMid,
        workspacePath: primaryWarmupTarget?.workspacePath,
        workspaceIdentity: primaryWarmupTarget?.workspaceIdentity,
        ...(options.agentWarmupTargets && options.agentWarmupTargets.length > 0
          ? { agentWarmupTargets: [...options.agentWarmupTargets] }
          : {}),
        runtimeProcessEnvPatch,
        // 同一窗口会后台索引所有已恢复 workspace，不只索引启动时的 active workspace。
        // fallback 必须跟随 local Host 生命周期常驻，否则非 active 历史目录被删除后会用失效 cwd 反复 spawn。
        agentSpawnFallbackCwd: options.agentSpawnFallbackCwd,
        remoteAssets: options.remoteAssets,
        // Host 的 X-Client-Language 以 Main 的实时界面语言为准；与后续变更消息同端口按序到达。
        ...(options.currentApplicationLocale ? { locale: options.currentApplicationLocale() } : {}),
      });
      // 映射键是 webContents.id，与 closed 处理器读取时用的是同一个值
      // 写入即代表该窗口当前唯一存活的 Host，旧条目到这里已被显式处置，不存在两个值并存
      // 必须先写映射再通知就绪，通知会触发呈现层回放，回放要按 wcId 反查 Host
      // [事务] 这两步之间没有可中断点（无 await 让出），外部观察不到「已就绪但查不到」的中间态
      // 后续刷新若再次走到这里，新 Host 覆盖旧条目，旧条目由上方处置分支负责收尾
      // [失败路径] 创建抛错时不会执行到这里，映射保留上一次的旧值，由 closed 处理器兜底清理
      // 读取方一律现取现用，不允许把 Host 引用缓存到窗口之外，缓存会让被替换的旧进程失去唯一释放路径
      options.windowHostProcessMap.set(wcId, child);
      options.onHostProcessReady?.(wcId);
      options.syncAutoUpdaterStateToWindow(win);
      options.syncReadyUpdateToWindow(win);
      options.syncPostUpdateReleaseNotesToWindow(win);
      options.reattachRemoteWorkspaceSessionsForWindow(win, `${label}:renderer-ready`);
    };

    if (!options.runtimeProcessEnvPatchPromise) {
      spawnLocalHost(options.runtimeProcessEnvFallbackPatch);
      return;
    }
    let settled = false;
    const waitTimeoutMs =
      options.runtimeProcessEnvWaitTimeoutMs ?? DEFAULT_RUNTIME_PROCESS_ENV_WAIT_TIMEOUT_MS;
    let timeout: ReturnType<typeof setTimeout> | null = null;
    const cancelWait = () => {
      if (settled) {
        return;
      }
      settled = true;
      if (timeout) {
        clearTimeout(timeout);
      }
    };
    // 超时与 promise 是同一场等待的两条出口，settled 保证只有先到的那条能建 Host
    // 先置 settled 再清定时器，反过来的话清理期间触发的回调会看到假值并重复创建
    // 只清自己登记的等待器，若期间发生过新 dom-ready，全局引用已指向新的取消函数
    // [失败路径] rejection 分支同样传入 fallback patch，与超时分支保持完全一致的降级结果
    // [权衡] 不在这里重试环境采集，重试会把启动时长翻倍，而 fallback 已足够让 Host 起来
    // 清除全局引用放在创建之前，避免创建过程中的新 dom-ready 取消到已完成的等待
    const completeWait = (runtimeProcessEnvPatch: Record<string, string>) => {
      if (settled) {
        return;
      }
      settled = true;
      if (timeout) {
        clearTimeout(timeout);
      }
      if (cancelRuntimeProcessEnvWait === cancelWait) {
        cancelRuntimeProcessEnvWait = null;
      }
      spawnLocalHost(runtimeProcessEnvPatch);
    };
    cancelRuntimeProcessEnvWait = cancelWait;
    timeout = setTimeout(() => {
      options.logger.warn(
        `[createWindow] runtime env prewarm exceeded ${waitTimeoutMs}ms after dom-ready (${label}), using shell-free fallback`,
      );
      completeWait(options.runtimeProcessEnvFallbackPatch);
    }, waitTimeoutMs);
    void options.runtimeProcessEnvPatchPromise.then(completeWait, (error) => {
      options.logger.warn(
        `[createWindow] runtime env prewarm failed (${label}), using shell-free fallback:`,
        error,
      );
      // 旧 rejection 分支传 undefined，Host 随后又同步执行同一个 login shell，
      // 可能把 Main 的白屏转移成 Host 卡死。Main 路径始终传入预计算 fallback patch。
      completeWait(options.runtimeProcessEnvFallbackPatch);
    });
  });

  // closed 是窗口侧资源的唯一释放点，此处的窗口已不可再操作，只能使用提前捕获的 id
  // 释放顺序固定：先注销遥测身份，再取消未完成的预热等待，最后才处置 Host
  // 删除映射放在处置之后，先删会让下面那次读取拿到 undefined，Host 就此失联
  // [资源] 远控窗口登记与会话绑定必须一起释放，只放一半会让远端仍能为已关窗口建立连接
  // 二次触发是幂等的，映射已被删除，第二次读取返回空，处置与删除都不会重复执行
  // [失败路径] 这里不做异常包裹，吞掉错误只会让后续释放少一步，掩盖后更难定位
  // 释放远控窗口使用 win.id，Host 相关调用使用 wcId，两套 id 空间不可互相替代
  win.on("closed", () => {
    unregisterMainApplicationWindow(wcId);
    cancelRuntimeProcessEnvWait?.();
    cancelRuntimeProcessEnvWait = null;
    options.logger.info(`[createWindow] window closed, killing host process (${label})`);
    const child = options.windowHostProcessMap.get(wcId);
    if (child) {
      options.disposeHostProcess(child, `${label}:window-closed`);
      options.windowHostProcessMap.delete(wcId);
    }
    void options.webRemoteControlManager.disposeWindow(browserWindowId);
    options.disposeRemoteWorkspaceSessionsForWindow(wcId, `${label}:window-closed`);
  });

  return win;
}

export function showCurrentWindowFromDock(primaryWindowCoordinator: {
  ensurePrimaryWindow(reason: string): Promise<void>;
}) {
  if (process.platform === "darwin") {
    app.show();
  }

  void primaryWindowCoordinator.ensurePrimaryWindow("dock-show-current-window");
}

export function focusWorkspaceInExistingWindow(
  path: string,
  windowWorkspaceMap: Map<number, Set<string>>,
  options?: { skipWindowId?: number },
): { activated: boolean; winId?: number } {
  for (const [winId, pathSet] of windowWorkspaceMap) {
    if (options?.skipWindowId === winId) {
      continue;
    }
    if (!pathSet.has(path)) {
      continue;
    }

    // 按 winId 反查是唯一可信来源，映射里必须只存路径集合，不缓存窗口对象
    // [资源] 取到的窗口可能已被销毁，反查为空或已销毁都必须当作不存在
    // 命中存活窗口时的顺序固定：最小化先还原，再聚焦，最后发送 FocusTab
    // 先还原再聚焦，最小化窗口直接聚焦不会还原，用户看不到任何变化
    // [失败路径] 失效条目在遍历中就地删除，避免同一个死 id 被反复命中并阻塞后续匹配
    const existingWin = BrowserWindow.fromId(winId);
    if (existingWin && !existingWin.isDestroyed()) {
      if (existingWin.isMinimized()) {
        existingWin.restore();
      }
      existingWin.focus();
      existingWin.webContents.send(PlatformChannels.FocusTab, path);
      return { activated: true, winId };
    }

    windowWorkspaceMap.delete(winId);
  }

  return { activated: false };
}

// Windows 任务栏 overlay 的 electron 侧装配：像素渲染在 unreadBadge.ts（纯逻辑，可单测），
// 这里只负责 BrowserWindow 枚举与 nativeImage 构造。spec 见 docs/desktop/windows-taskbar-unread-badge.md
const windowsTaskbarOverlayLayout = supportsNativeWindowsRoundedCorners(
  process.platform,
  readPlatformRelease(),
)
  ? "windows-11"
  : "windows-10";

const applyWindowsTaskbarOverlay = createWindowsTaskbarOverlayApplier({
  getAllWindows: () => BrowserWindow.getAllWindows(),
  // Windows 固定把 overlay 显示为 16×16。直接传硬边 32px 圆再让 Shell 缩放会发糊、
  // 边缘像缺口；这里提供原生 1x(16px) + 2x(32px) 纯红抗锯齿表示。
  // label 只用于无障碍 description，屏幕阅读器仍播报具体数量。
  createBadgeImage: () => {
    const image = nativeImage.createEmpty();
    image.addRepresentation({
      scaleFactor: 1,
      width: 16,
      height: 16,
      buffer: Buffer.from(renderTaskbarStatusDotPixels(1, windowsTaskbarOverlayLayout)),
    });
    image.addRepresentation({
      scaleFactor: 2,
      width: 32,
      height: 32,
      buffer: Buffer.from(renderTaskbarStatusDotPixels(2, windowsTaskbarOverlayLayout)),
    });
    return image;
  },
});

export function syncApplicationUnreadBadge(windowUnreadCountMap: Map<number, number>) {
  const totalUnreadCount = maxWindowUnreadCounts(windowUnreadCountMap);
  syncUnreadBadgeForPlatform({
    platform: process.platform,
    totalUnreadCount,
    setBadgeCount: (count) => {
      app.setBadgeCount(count);
    },
    applyOverlay: applyWindowsTaskbarOverlay,
  });
  // 托盘角标：Windows/Linux 托盘右上角小徽章（macOS 无托盘，由 Dock 角标承担）。
  applyDesktopTrayUnreadBadge(totalUnreadCount);
}

export function handleWindowUnreadCountSync(
  win: BrowserWindow | null,
  payload: unknown,
  windowUnreadCountMap: Map<number, number>,
  logger: { warn: (...args: unknown[]) => void },
) {
  const unreadCount = parseWindowUnreadCount(payload);
  if (unreadCount == null) {
    logger.warn("[sync-window-unread-count] invalid payload:", payload);
    return false;
  }

  if (!win) {
    return false;
  }

  if (unreadCount === 0) {
    windowUnreadCountMap.delete(win.id);
  } else {
    windowUnreadCountMap.set(win.id, unreadCount);
  }
  syncApplicationUnreadBadge(windowUnreadCountMap);
  return true;
}

export function configureDockMenu(getLabel: () => string, onShowCurrentWindow: () => void) {
  if (process.platform !== "darwin" || app.dock == null) {
    return;
  }

  const dockMenu = Menu.buildFromTemplate([
    {
      label: getLabel(),
      click: onShowCurrentWindow,
    },
  ]);

  app.dock.setMenu(dockMenu);
}

export function handleDesktopWindowCloseRequest(options: {
  platform: NodeJS.Platform;
  forceQuit: boolean;
  explicitQuitRequested?: boolean;
  closeToTray?: boolean;
  /**
   * Linux 关闭驻留的托盘能力（spec：docs/desktop/linux-close-to-tray.md）。
   * GNOME 等无 StatusNotifierWatcher 的桌面托盘不渲染且不报错，必须在隐藏前显式确认能力；
   * 空值按"不可用"安全默认，走确认退出路径，避免窗口隐藏后失联。
   */
  closeToTraySupported?: boolean;
  isLastWindow: boolean;
  label: string;
  logger: { info: (...args: unknown[]) => void };
  shouldConfirmQuit?: boolean;
  confirmQuit: () => boolean;
  requestQuit: () => void;
  hideWindow?: () => void;
}) {
  // CR 修复:win32 不能短路丢弃 closeToTraySupported——它承载 resolveCloseToTraySupported
  // 的合并裁决(Windows=托盘实例创建成功)。托盘创建失败时隐藏窗口即失联,与 spec
  // "关窗分支与设置页能力查询都读同一合并结果"保持一致。
  // 托盘隐藏只对 win32 与 linux 开放，darwin 的关闭语义走另一条路径
  // 能力判定必须是严格等于 true，缺省按不可用处理，宁可弹确认也不能把窗口藏进不存在的托盘
  // [失败路径] 无 StatusNotifierWatcher 的桌面不报错也不渲染托盘，隐藏等于永久失联
  // 隐藏前先记日志，之后没有窗口可看，日志是唯一能还原用户操作的证据
  // [权衡] 不用平台判断代替能力探测，Windows 上托盘实例也可能创建失败，必须读合并后的结果
  const canHideToTray =
    (options.platform === "win32" || options.platform === "linux") &&
    options.closeToTraySupported === true;
  if (
    canHideToTray &&
    options.closeToTray &&
    !options.forceQuit &&
    !options.explicitQuitRequested
  ) {
    options.logger.info(`[createWindow] window close hidden to tray (${options.label})`);
    options.hideWindow?.();
    return true;
  }

  // 这行是「关窗」与「退出应用」的分界，返回 false 表示放行关闭、进程继续存活
  // darwin 语义上关闭最后一个窗口不等于退出，Dock 图标仍在，点击可重新建窗
  // forceQuit 时无论平台都放行，退出流程已经决定终止进程，拦下来会造成关不掉的假象
  // 还有其它窗口时必须不弹确认框，用户关的只是一扇窗，不该对整应用做退出确认
  // [权衡] 三个条件合在一个判断里而不是分层分支，顺序无关且必须同时放行，拆开容易漏判
  // 走到下方的才是真正的退出候选：最后窗口、非 darwin、非强制退出
  if (options.platform === "darwin" || options.forceQuit || !options.isLastWindow) {
    return false;
  }

  if (options.shouldConfirmQuit === false) {
    options.logger.info(
      `[createWindow] last window close skipped confirmation, quitting app (${options.label})`,
    );
    options.requestQuit();
    return true;
  }

  if (!options.confirmQuit()) {
    options.logger.info(`[createWindow] last window close canceled by user (${options.label})`);
    return true;
  }

  options.logger.info(
    `[createWindow] last window close confirmed, quitting app (${options.label})`,
  );
  options.requestQuit();
  return true;
}
