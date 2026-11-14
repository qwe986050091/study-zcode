// INV-01 载荷先过模式校验：守住位置 解析入口；改错故障 非法载荷进入通知流程。
// INV-02 平台不支持时拒绝：守住位置 能力判断；改错故障 调用原生接口抛错。
// INV-03 任一窗口聚焦即不弹：守住位置 焦点判断；改错故障 用户正在看界面仍被打扰。
// INV-04 文案缺失直接拒绝：守住位置 空串判断；改错故障 英文界面弹出中文硬编码。
// INV-05 去重按状态与标识组合：守住位置 键构造；改错故障 不同状态互相吞掉。
// INV-06 人机阻塞请求按请求号去重：守住位置 目标选择；改错故障 连续两次提问只弹一条。
// INV-07 去重记录过期即清理：守住位置 清理循环；改错故障 映射无界增长。
// INV-08 活跃通知集合设上限：守住位置 容量判断；改错故障 长会话内存持续上涨。
// INV-09 超限淘汰最早一条：守住位置 迭代首项；改错故障 新通知无法插入。
// INV-10 通知对象显式持有：守住位置 保留调用；改错故障 点击监听在点击前被回收。
// INV-11 点击与关闭都释放：守住位置 两个回调；改错故障 集合只增不减。
// INV-12 发送窗口已销毁时记警告：守住位置 销毁判断；改错故障 向已销毁窗口发消息抛错。
// INV-13 点击后先恢复再聚焦：守住位置 调用顺序；改错故障 窗口留在后台。
// INV-14 特定平台额外激活应用：守住位置 平台分支；改错故障 点通知无法唤起窗口。
// INV-15 通知静音不打扰：守住位置 静音字段；改错故障 静音模式仍播放提示音。
// INV-16 点击事件回传任务标识：守住位置 通道参数；改错故障 渲染层不知道点了哪条。
// INV-17 声音通道在展示后发送：守住位置 调用顺序；改错故障 无声或重复播放。
// INV-18 测试钩子只清理内存集合：守住位置 导出范围；改错故障 生产路径可清空真实通知。
//
// 模块职责：desktopNotifications 必须完成主进程任务通知的校验、去重、展示与点击唤起。
// 状态所有权：recentTaskNotificationTimestamps 去重表与 activeTaskNotifications 集合都是模块级内存状态。
// 阅读顺序：先看去重与容量，再看窗口唤起，最后看派发主流程。
import { app, BrowserWindow, Notification } from "electron";
import type { IpcMainEvent, IpcMainInvokeEvent } from "electron";
import type { TaskNotificationPayload } from "@zcode/shared";
import { formatZodError, PlatformChannels, taskNotificationPayloadSchema } from "@zcode/shared";

const TASK_NOTIFICATION_DEDUPE_WINDOW_MS = 3000;
const MAX_ACTIVE_TASK_NOTIFICATIONS = 100;
const recentTaskNotificationTimestamps = new Map<string, number>();
const activeTaskNotifications = new Set<Notification>();

function isAnyAppWindowFocused() {
  return BrowserWindow.getAllWindows().some(
    (window) => !window.isDestroyed() && window.isFocused(),
  );
}

// 必须先清理 TASK_NOTIFICATION_DEDUPE_WINDOW_MS 窗口外的时间戳；permission_request 与人机阻塞请求按 requestId 去重；其余状态按 taskId 去重。
function shouldSuppressDuplicateTaskNotification(
  taskId: string,
  status: TaskNotificationPayload["status"],
  requestId?: string,
) {
  const now = Date.now();

  for (const [key, timestamp] of recentTaskNotificationTimestamps) {
    if (now - timestamp > TASK_NOTIFICATION_DEDUPE_WINDOW_MS) {
      recentTaskNotificationTimestamps.delete(key);
    }
  }

  // elicitation_request 和 permission_request 一样代表一次具体的人机阻塞请求。
  // 如果仍按 taskId 去重，同一任务连续 AskUserQuestion/计划确认会在 3 秒内漏掉第二条通知。
  const dedupeTarget =
    status === "permission_request" || status === "elicitation_request"
      ? requestId?.trim() || taskId
      : taskId;
  const dedupeKey = `${status}:${dedupeTarget}`;
  const lastTimestamp = recentTaskNotificationTimestamps.get(dedupeKey);
  if (lastTimestamp != null && now - lastTimestamp < TASK_NOTIFICATION_DEDUPE_WINDOW_MS) {
    return true;
  }

  recentTaskNotificationTimestamps.set(dedupeKey, now);
  return false;
}

function retainTaskNotification(notification: Notification) {
  activeTaskNotifications.add(notification);

  if (activeTaskNotifications.size <= MAX_ACTIVE_TASK_NOTIFICATIONS) {
    return;
  }

  const oldestNotification = activeTaskNotifications.values().next().value;
  if (oldestNotification) {
    activeTaskNotifications.delete(oldestNotification);
  }
}

function releaseTaskNotification(notification: Notification) {
  activeTaskNotifications.delete(notification);
}

export function getActiveTaskNotificationCountForTest() {
  return activeTaskNotifications.size;
}

export function resetActiveTaskNotificationsForTest() {
  activeTaskNotifications.clear();
  recentTaskNotificationTimestamps.clear();
}

// 先从最小化 restore；不可见时先 show；macOS 再 activate app 后 focus BrowserWindow。
export function focusTaskNotificationWindow(senderWindow: BrowserWindow) {
  if (senderWindow.isMinimized()) {
    senderWindow.restore();
  }

  if (!senderWindow.isVisible()) {
    senderWindow.show();
  }

  // macOS 点通知时如果窗口曾被隐藏/最小化，必须先恢复窗口，再激活 app，
  // 最后聚焦 BrowserWindow；否则 app.focus 抢到前台时没有可显示窗口，后续 focus 可能被系统忽略。
  if (process.platform === "darwin") {
    app.dock?.show();
    app.show();
    app.focus({ steal: true });
  }

  senderWindow.focus();
}

// safeParse 校验失败只记警告；窗口聚焦时不弹通知；文案缺失拒绝展示；Notification 对象显式持有到点击或关闭。
export function dispatchTaskNotification(options: {
  event: IpcMainEvent | IpcMainInvokeEvent;
  payload: unknown;
  logger: { info: (...args: unknown[]) => void; warn: (...args: unknown[]) => void };
}): boolean {
  const result = taskNotificationPayloadSchema.safeParse(options.payload);
  if (!result.success) {
    options.logger.warn("[show-task-notification] invalid payload:", formatZodError(result.error));
    return false;
  }

  if (!Notification.isSupported()) {
    options.logger.warn("[show-task-notification] notification is not supported on this platform");
    return false;
  }

  if (isAnyAppWindowFocused()) {
    return false;
  }

  const { taskId, status, requestId, title, body } = result.data;
  const notificationTitle = title.trim();
  const notificationBody = body.trim();
  if (!notificationTitle || !notificationBody) {
    // main process 没有 renderer 当前语言上下文，不能在这里兜底生成中文通知文案。
    // 通知文案必须由 renderer 侧按 i18n 生成后传入；缺失时直接拒绝展示，避免英文界面弹出中文硬编码。
    options.logger.warn("[show-task-notification] missing localized notification copy", {
      taskId,
      status,
      hasTitle: Boolean(notificationTitle),
      hasBody: Boolean(notificationBody),
    });
    return false;
  }

  if (shouldSuppressDuplicateTaskNotification(taskId, status, requestId)) {
    return false;
  }

  const senderWindow = BrowserWindow.fromWebContents(options.event.sender);
  const notification = new Notification({
    title: notificationTitle,
    body: notificationBody,
    silent: true,
  });

  // Electron 原生 Notification 如果只存在于函数局部变量里，系统通知仍能显示，
  // 但主进程 JS 对象可能在用户点击前被回收，导致 click listener 丢失。
  // 这里显式持有对象，等点击/关闭后释放，保证“有通知”与“点击可唤起”属于同一生命周期。
  retainTaskNotification(notification);

  notification.once("click", () => {
    releaseTaskNotification(notification);

    if (!senderWindow || senderWindow.isDestroyed()) {
      options.logger.warn("[show-task-notification] click ignored: sender window is gone", {
        taskId,
      });
      return;
    }

    focusTaskNotificationWindow(senderWindow);
    senderWindow.webContents.send(PlatformChannels.TaskNotificationClick, taskId);
    options.logger.info("[show-task-notification] notification click handled", {
      taskId,
      windowId: senderWindow.id,
    });
  });
  notification.once("close", () => {
    releaseTaskNotification(notification);
  });

  notification.show();
  options.event.sender.send(PlatformChannels.TaskNotificationSound);
  return true;
}
