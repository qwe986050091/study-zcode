// INV-01 埋点失败不影响业务终态：守住位置 旁路捕获；改错故障 启动成功被误判为失败。
// INV-02 窗口缺失显式报错：守住位置 缺失判断；改错故障 用无效窗口标识继续启动。
// INV-03 成功后才上报成功：守住位置 上报位置；改错故障 启动失败也记成功。
// INV-04 失败附带错误分类：守住位置 分类调用；改错故障 遥测只能看到笼统失败。
// INV-05 失败后原样抛出：守住位置 重抛语句；改错故障 渲染进程收不到错误原因。
// INV-06 工作区类型只看上下文：守住位置 空值或运算；改错故障 本地会话被记成远端。
// INV-07 远端类型解析可缺席：守住位置 条件解析；改错故障 非法身份导致上报异常。
// INV-08 授权与启动分两步：守住位置 两次调用；改错故障 未授权也能启动。
// INV-09 授权在启动前完成：守住位置 语句顺序；改错故障 启动读到过期授权。
// INV-10 状态变更通知不阻塞：守住位置 不等待调用；改错故障 通知卡住主进程。
// INV-11 通知异常不外泄：守住位置 空捕获；改错故障 未处理拒绝拖垮进程。
// INV-12 载荷先校验再用：守住位置 安全解析；改错故障 畸形载荷写入管理器。
// INV-13 校验失败静默返回：守住位置 早退分支；改错故障 非法通知触发崩溃。
// INV-14 停止只对真实窗口生效：守住位置 窗口判断；改错故障 空窗口调用停止报错。
// INV-15 状态查询缺窗口回空闲：守住位置 三元兜底；改错故障 状态接口直接抛异常。
// INV-16 通道名集中取自常量：守住位置 通道常量；改错故障 主渲染两侧通道名漂移。
// INV-17 管理器能力通过依赖注入：守住位置 依赖接口；改错故障 单测必须启动完整管理器。
// INV-18 注册函数只接线不持状态：守住位置 函数职责；改错故障 多次注册叠加监听。
//
// 模块职责：desktopWebRemoteControlIpc 必须把 Web 远程控制的授权、启动、通知、停止与查询接到 IPC。
// 状态所有权：无状态；管理器与遥测上报全部由依赖注入。
// 阅读顺序：先看管理器接口，再看启动操作，最后看四个通道注册。
import { BrowserWindow, ipcMain } from "electron";
import type { WebContents } from "electron";
import {
  buildWebRemoteControlStartResultTelemetry,
  classifyRemoteUsageError,
  parseRemoteWorkspaceIdentity,
  PlatformChannels,
  webRemoteControlAuthStateChangeSchema,
  type WebRemoteControlAuthStateChange,
  type TelemetryEventPayload,
  type WebRemoteControlContext,
  type WebRemoteControlStartResult,
  type WebRemoteControlStatus,
} from "@zcode/shared";
import type { WebRemoteControlStartAuthorization } from "./webRemoteControlManager.js";

// 五个能力覆盖 authorizeStart、startAuthorized、notifyAuthStateChanged、stop、getStatus。
// 管理器由依赖注入。
// 接口不暴露 Electron 类型。
export interface WebRemoteControlIpcManager {
  // authorizeStart 只做授权判定并返回凭据，真正的启动在 startAuthorized 里执行。
  authorizeStart: (
    // windowId 是 Electron 的 BrowserWindow.id，不是渲染进程的 webContents.id。
    windowId: number,
    // context 原样透传，授权结果只对这一次 context 有效。
    context: WebRemoteControlContext,
  ) => WebRemoteControlStartAuthorization;
  // startAuthorized 必须拿到上一步的 authorization，缺它也启动不了。
  startAuthorized: (
    // windowId 与授权阶段拿到的是同一个值，两者不一致说明窗口已被重建。
    windowId: number,
    // context 再次传入而不缓存，启动阶段看到的工作区与授权阶段一致。
    context: WebRemoteControlContext,
    // authorization 由 authorizeStart 产出，管理器靠它判断这一步是否已被允许。
    authorization: WebRemoteControlStartAuthorization,
  ) => Promise<WebRemoteControlStartResult>;
  // notifyAuthStateChanged 返回 Promise，调用方可以选择等待或者放弃等待。
  notifyAuthStateChanged(windowId: number, change: WebRemoteControlAuthStateChange): Promise<void>;
  // stop 只负责停止，窗口不存在时由调用方决定是否跳过。
  stop(windowId: number): Promise<void>;
  // getStatus 同步返回状态，缺窗口时由注册方兜底成 idle。
  getStatus(windowId: number): WebRemoteControlStatus;
}

// 依赖表只有遥测上报与管理器两项，注册函数因此不依赖 Electron 之外的全局。
interface WebRemoteControlIpcDependencies {
  // reportRemoteUsageEvent 由外部注入，测试可以换成只记录调用的替身。
  reportRemoteUsageEvent: (rendererId: number, event: TelemetryEventPayload) => void;
  // webRemoteControlManager 必须实现上面五个能力，接口以外的成员一律不调用。
  webRemoteControlManager: WebRemoteControlIpcManager;
}

// 埋点是旁路能力；异常必须被捕获且不改变业务终态；调用方原本的错误继续抛出。
function reportRemoteUsageEventSafely(
  // 参数类型直接取自 WebRemoteControlIpcDependencies，签名漂移会在编译期暴露。
  reportRemoteUsageEvent: WebRemoteControlIpcDependencies["reportRemoteUsageEvent"],
  // rendererId 用发出请求的 webContents.id，遥测据此归因到窗口。
  rendererId: number,
  // event 已经是构造好的遥测载荷，这个函数不做二次加工。
  event: TelemetryEventPayload,
): void {
  try {
    // reportRemoteUsageEvent 的调用只出现一次，所有异常都由外层 catch 兜住。
    reportRemoteUsageEvent(rendererId, event);
  } catch {
    // Bug 根因：埋点回调原来位于业务 operation 的 try 内，回调抛错会把已成功的启动误判为失败，
    // 甚至覆盖真正的业务错误。埋点是旁路能力，这里必须吞掉异常并保留 operation 的原始终态。
  }
}

// resolveWorkspaceKind 只读上下文里的两个可选字段，不访问任何管理器状态。
function resolveWorkspaceKind(context: WebRemoteControlContext): "local" | "remote" {
  // workspaceIdentity 与 remoteSessionId 任一非空即判 remote，两个都空才是本地会话。
  return context.workspaceIdentity?.trim() || context.remoteSessionId?.trim() ? "remote" : "local";
}

// 必须先算 workspaceKind 再执行 operation；窗口缺失立即抛错；成功与失败各上报一次 telemetry；失败原样抛出。
async function runStartOperation(input: {
  // context 是本次启动的完整上下文，工作区类型与远端类型都由它推导。
  context: WebRemoteControlContext;
  // sender 用来反查窗口并取渲染进程 id，是整个操作的唯一来源。
  sender: WebContents;
  // missingWindowMessage 由调用方给定，窗口缺失时的报错因此可以按通道定制。
  missingWindowMessage: string;
  // operation 接收窗口 id 并返回启动结果，授权与启动的实际顺序由调用方决定。
  operation: (windowId: number) => Promise<WebRemoteControlStartResult>;
  // 遥测函数必须传进来，runStartOperation 不直接依赖模块外的单例。
  reportRemoteUsageEvent: WebRemoteControlIpcDependencies["reportRemoteUsageEvent"];
}): Promise<WebRemoteControlStartResult> {
  // workspaceKind 在 try 之前算好，失败分支上报时才能带上同一个值。
  const workspaceKind = resolveWorkspaceKind(input.context);
  // remoteKind 只在给了 workspaceIdentity 时才解析。
  const remoteKind = input.context.workspaceIdentity
    // parseRemoteWorkspaceIdentity 返回空表示身份不合法，此时 kind 保持 undefined。
    ? parseRemoteWorkspaceIdentity(input.context.workspaceIdentity)?.kind
    // parseRemoteWorkspaceIdentity 解析失败不上抛，远端类型只是遥测的附加字段。
    : undefined;
  // rendererId 在进入 try 之前取出，catch 分支上报失败事件时还要用它。
  const rendererId = input.sender.id;
  try {
    // 从 sender 反查窗口，而不是信任渲染进程传来的窗口 id。
    const win = BrowserWindow.fromWebContents(input.sender);
    // win 为空时不继续，否则后面拿到的 id 无法对应任何真实窗口。
    if (!win) {
      // 抛出 missingWindowMessage 给定文案，渲染进程能看到具体失败原因。
      throw new Error(input.missingWindowMessage);
    }
    // 交互边界：远控面板已有显式用户操作，main 只校验窗口并绑定目标，
    // 不再叠加原生确认弹窗，避免一次操作出现两层确认。
    const response = await input.operation(win.id);
    // 成功上报发生在 operation 返回之后，顺序颠倒会把失败记成成功。
    reportRemoteUsageEventSafely(
      input.reportRemoteUsageEvent,
      rendererId,
      buildWebRemoteControlStartResultTelemetry({
        // result 固定为 success，这个分支只在没有抛错时执行。
        result: "success",
        workspaceKind,
        remoteKind,
      }),
    );
    // 原样返回 response，不在这里改写字段。
    return response;
  } catch (error) {
    // catch 分支同样只上报一次，且不会吞掉原错误。
    reportRemoteUsageEventSafely(
      input.reportRemoteUsageEvent,
      rendererId,
      buildWebRemoteControlStartResultTelemetry({
        // result 固定为 failure，与成功分支共用同一个埋点构造器。
        result: "failure",
        workspaceKind,
        remoteKind,
        // classifyRemoteUsageError 把异常归到有限几类，遥测才不会只剩一句失败。
        errorCategory: classifyRemoteUsageError(error),
      }),
    );
    // 原样重抛，渲染进程的 invoke 收到的是同一条错误。
    throw error;
  }
}

// 三个 handle 与一个监听。
// getStatus 缺 BrowserWindow 时必须回空闲状态。
// notifyAuthStateChanged 不阻塞主进程。
export function registerWebRemoteControlIpcHandlers(
  // dependencies 由调用方装配，注册函数本身不创建管理器。
  dependencies: WebRemoteControlIpcDependencies,
): void {
  // 授权状态变更走 on 而不是 handle，渲染进程发完即走不等回执。
  ipcMain.on(PlatformChannels.WebRemoteControlAuthStateChanged, (event, payload: unknown) => {
    // safeParse 不抛错，畸形载荷在这里变成 success=false。
    const parsed = webRemoteControlAuthStateChangeSchema.safeParse(payload);
    // 窗口从 event.sender 反查，通知只作用于发起的那个窗口。
    const win = BrowserWindow.fromWebContents(event.sender);
    // parsed.success 为假或 win 为空时静默返回，非法通知不会触发崩溃。
    if (!parsed.success || !win) return;
    // 单向通知不把异步异常泄漏到 Electron；下次通知或 workspace sync 可重试恢复。
    void dependencies.webRemoteControlManager
      .notifyAuthStateChanged(win.id, parsed.data)
      .catch(() => {});
  });
  // 启动通道用 handle 注册，渲染进程拿到的是 Promise。
  ipcMain.handle(
    PlatformChannels.StartWebRemoteControl,
    async (event, context: WebRemoteControlContext) =>
      // 启动逻辑全部委托给 runStartOperation，通道层只做接线。
      runStartOperation({
        // context 原样透传，通道层不解释其中的字段。
        context,
        // sender 直接给 event.sender，保证窗口反查用的是真实发起者。
        sender: event.sender,
        // missingWindowMessage 在这里固定，渲染进程可以直接展示。
        missingWindowMessage: "未找到当前窗口，无法开启 Web 远程控制",
        // operation 只接收窗口 id，窗口缺失的判断已经在 runStartOperation 里做过。
        operation: (windowId) => {
          // 每次调用都重新取 webRemoteControlManager，不在注册时缓存引用。
          const manager = dependencies.webRemoteControlManager;
          // 先授权再启动，授权失败时 startAuthorized 不会被调用。
          const authorization = manager.authorizeStart(windowId, context);
          // authorization 必须来自上一行，跳过授权直接启动会丢掉这层校验。
          return manager.startAuthorized(windowId, context, authorization);
        },
        // 遥测函数透传，runStartOperation 不自己去找上报入口。
        reportRemoteUsageEvent: dependencies.reportRemoteUsageEvent,
      }),
  );

  // StopWebRemoteControl 通道只在窗口存在时动作，窗口已销毁属于正常竞态。
  ipcMain.handle(PlatformChannels.StopWebRemoteControl, async (event) => {
    // 从 sender 反查窗口，不接受渲染进程自报的 id。
    const win = BrowserWindow.fromWebContents(event.sender);
    // win 为空就什么都不做，停止接口对已关闭窗口是幂等的。
    if (win) {
      // 等 stop 完成再返回，渲染进程据此知道资源已经释放。
      await dependencies.webRemoteControlManager.stop(win.id);
    }
  });

  // 状态查询是同步 handle，返回值直接序列化给渲染进程。
  ipcMain.handle(PlatformChannels.GetWebRemoteControlStatus, (event) => {
    // win 反查失败时走下面的 idle 分支，不抛错。
    const win = BrowserWindow.fromWebContents(event.sender);
    // win 为空时返回固定 idle，有窗口时才查管理器。
    return win
      // getStatus 只读管理器状态，不会因为查询而触发启动。
      ? dependencies.webRemoteControlManager.getStatus(win.id)
      // 缺窗口返回 idle，状态接口因此永不抛异常。
      : { status: "idle" as const };
  });
}
