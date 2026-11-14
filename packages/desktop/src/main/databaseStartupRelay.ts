// INV-01 每窗口只保留一个绑定：守住位置 windowBindings 的覆盖与释放；改错故障 旧 Host 的监听继续重放 ready。
// INV-02 每个 Host 进程一个 startupId：守住位置 WeakMap 写入；改错故障 新旧两代状态互相覆盖。
// INV-03 状态按 sequence 单调前进：守住位置 applyState 的早退；改错故障 乱序帧把界面回退到旧阶段。
// INV-04 ready 只广播一次且随清空监听：守住位置 ready 分支；改错故障 重连时重复调度初始化。
// INV-05 控制命令只认本窗口渲染进程且先过 schema：守住位置 control 入口；改错故障 任意窗口可关闭数据库。
// INV-06 进程退出即合成 failed：守住位置 onExit；改错故障 旧 ready 证明放行新端口。
// INV-07 转发前校验绑定与窗口存活：守住位置 forward；改错故障 窗口销毁后 send 抛错。
// INV-08 遥测失败不阻断启动：守住位置 单独捕获；改错故障 采集异常中断 ready 传播。
// INV-09 释放幂等且按身份删除：守住位置 dispose；改错故障 二次释放误删新绑定。
// INV-10 退出后不再向子进程发消息：守住位置 exited 判断；改错故障 对已退出进程 postMessage。
//
// 模块职责：把 Host 子进程的数据库启动状态中继到渲染进程，并回传用户控制命令。
// 阅读顺序：先看同窗口绑定与转发，再看状态合并，最后看控制命令与退出收尾。
import { randomUUID } from "node:crypto";
import { ipcMain, type BrowserWindow, type UtilityProcess } from "electron";
import {
  HostMessageTypes,
  InternalChannels,
  databaseStartupControlSchema,
  type DatabaseStartupState,
} from "@zcode/shared";
import { reportDatabaseStartupState } from "./databaseStartupTelemetry.js";

let localStorageReady = false;
let quit: (() => void) | undefined;
export function configureDatabaseStartupQuit(handler: () => void): void {
  quit = handler;
}
const readyListeners = new Set<() => void>();
/** Main 只按 Host ready 调度既有 scheduler，不拥有迁移状态或账本。 */
export function onLocalDatabaseStartupReady(listener: () => void): void {
  if (localStorageReady) listener();
  else readyListeners.add(listener);
}

const windowBindings = new WeakMap<BrowserWindow, () => void>();
const hostStartupIds = new WeakMap<UtilityProcess, string>();
export function getDatabaseStartupPortPayload(
  child: UtilityProcess,
): { databaseStartupId: string } | undefined {
  const databaseStartupId = hostStartupIds.get(child);
  return databaseStartupId ? { databaseStartupId } : undefined;
}

export function bindDatabaseStartupRelay(
  win: BrowserWindow,
  child: UtilityProcess,
  startupId = randomUUID(),
) {
  // 同窗口重建 Host 时，旧监听不能继续重放 ready 或接收用户控制命令。
  // 先释放同窗口的旧绑定：旧 Host 的监听不能继续重放 ready。
  // 释放只按窗口身份走 windowBindings，不影响其他窗口与子进程。
  // 绑定表用 WeakMap，窗口被回收时不留引用。
  // 覆盖发生在新旧 Host 交替时，属于正常路径而非异常。
  windowBindings.get(win)?.();
  hostStartupIds.set(child, startupId);
  let disposed = false;
  let latest: DatabaseStartupState | undefined;
  let exited = false;
  const forward = (state: DatabaseStartupState) => {
    if (!disposed && !win.isDestroyed() && !win.webContents.isDestroyed())
      win.webContents.send(InternalChannels.DatabaseStartupState, state);
  };
  // 同一代内按 sequence 单调：迟到或重复的帧直接丢弃。
  // 先更新 latest 再转发，保证随后的 snapshot 拿到最新值。
  // 遥测单独兜住异常，采集失败不能阻断启动链路。
  // ready 是全局一次性事件：翻 ready 标志、广播、清空监听三步必须一次做完，不可拆分。
  // 只有 phase 为 ready 才触发，失败与中间态都不解锁初始化。
  const applyState = (state: DatabaseStartupState) => {
    if (latest && state.startupId === latest.startupId && state.sequence <= latest.sequence) return;
    latest = state;
    forward(state);
    try {
      reportDatabaseStartupState(state);
    } catch {
      /* 遥测故障不阻断启动。 */
    }
    if (state.phase === "ready" && !localStorageReady) {
      localStorageReady = true;
      for (const listener of readyListeners) listener();
      readyListeners.clear();
    }
  };
  const receive = (state: DatabaseStartupState) => {
    if (disposed || exited || state.startupId !== startupId) return;
    applyState(state);
  };
  // 只接受本窗口渲染进程经 senderId 发来的控制命令，其他来源直接忽略。
  // 载荷先过 schema，畸形输入不进入子进程。
  // exit 走宿主注入的退出回调，模块本身不碰 app 生命周期。
  // snapshot 只回放缓存，不向子进程再要一次。
  const control = (event: Electron.IpcMainEvent, raw: unknown) => {
    if (disposed || event.sender !== win.webContents) return;
    const result = databaseStartupControlSchema.safeParse(raw);
    if (!result.success) return;
    if (result.data.action === "exit") {
      quit?.();
      return;
    }
    if (result.data.action === "snapshot" && latest) forward(latest);
    if (!exited)
      child.postMessage({ type: HostMessageTypes.DatabaseStartupControl, control: result.data });
  };
  // 先落 exited 与映射清理，后续控制命令不再转发。
  // 从未收到过状态时也要合成一条 starting，保证 failed 有完整上下文。
  // 走 applyState 而不是直接转发，让序列号与遥测走同一条路。
  const onExit = () => {
    exited = true;
    hostStartupIds.delete(child);
    if (!latest) {
      const now = Date.now();
      latest = {
        schemaVersion: 1,
        startupId,
        attemptId: randomUUID(),
        sequence: 0,
        startedAt: now,
        updatedAt: now,
        phase: "starting",
        disk: [],
      };
    }
    // 即使旧代曾 ready，退出后的 reload 也只能读到失败，不能用旧证明放行新端口。
    if (latest.phase !== "failed")
      applyState({
        ...latest,
        sequence: latest.sequence + 1,
        updatedAt: Date.now(),
        failedPhase: latest.phase,
        phase: "failed",
        errorCode: "transport_closed",
      });
  };
  // 幂等：重复调用直接返回，避免重复摘监听。
  // 窗口映射仍指向自己时才从 windowBindings 删除，防止误删新绑定。
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    ipcMain.removeListener(InternalChannels.DatabaseStartupControl, control);
    win.removeListener("closed", dispose);
    child.removeListener("exit", onExit);
    hostStartupIds.delete(child);
    if (windowBindings.get(win) === dispose) windowBindings.delete(win);
  };
  windowBindings.set(win, dispose);
  ipcMain.on(InternalChannels.DatabaseStartupControl, control);
  win.once("closed", dispose);
  child.once("exit", onExit);
  return { receive, startupId };
}
