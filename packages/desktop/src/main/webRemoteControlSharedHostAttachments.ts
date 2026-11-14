// INV-01 本地附着必须复用窗口既有 host 进程：守住位置 本地附着取值；改错故障：为远程控制单独起进程，窗口关闭后附件不回收。
// INV-02 查找 host 进程用 webContents 标识而不是窗口标识：守住位置 标识换算；改错故障：直接用窗口标识在部分窗口形态下查不到进程，误报缺失。
// INV-03 缺失 host 立即抛结构化错误：守住位置 缺失分支；改错故障：返回空引用会让调用方在投递消息处崩溃，错误码丢失。
// INV-04 远程分支先校验会话标识再校验身份：守住位置 两个检查顺序；改错故障：缺身份时报成会话缺失，界面无法给出正确修复指引。
// INV-05 身份去空白后仍非空才可用：守住位置 身份规整；改错故障：全空白身份被当作有效键，多个工作区共用一个隔离域。
// INV-06 工作区键优先用身份、其次才用路径：守住位置 键回退；改错故障：优先路径会让同一远端两种写法各自建域。
// INV-07 传输端口所有权随附件转移：登记后只由释放函数关闭，守住位置 附件登记；改错故障：调用方另持端口自行关闭，释放时二次关闭抛错。
// INV-08 端口只传递一次：创建后立即随消息发出，守住位置 消息参数；改错故障：重复投递会让同一端被多个接收方争抢。
// INV-09 附件标识单调递增且全局唯一：守住位置 计数器；改错故障：复用标识会让释放命中另一个窗口的附件。
// INV-10 登记表必须记录窗口标识：守住位置 登记写入；改错故障：缺窗口归属后窗口关闭无法定向清理，端口泄漏。
// INV-11 子系统注销只清理自身条目：守住位置 子系统遍历；改错故障：按标识猜测清理会误删其它子系统的附着。
// INV-12 释放是幂等的：守住位置 释放首段存在判断；改错故障：重复释放会二次关闭端口并在日志中刷错误。
// INV-13 关闭端口失败只告警不抛错：守住位置 关闭异常分支；改错故障：抛错会中断窗口销毁流程，留下未清理条目。
// INV-14 按窗口清理遍历快照：守住位置 数组拷贝；改错故障：边遍历边删除会让迭代器跳过条目。
// INV-15 附着结果携带入口标识用于幂等：守住位置 返回值；改错故障：缺入口标识时上层无法判断是否已附着。
// INV-16 远程附着透传远端类型：守住位置 返回字段；改错故障：丢失远端类型后渲染层无法区分本地与远端来源。
// INV-17 依赖全部由调用方注入：守住位置 工厂参数；改错故障：模块内直接引用全局 Electron 对象会让测试无法替换。
// INV-18 本模块不持有窗口生命周期：只响应显式释放，守住位置 导出接口；改错故障：自行监听窗口事件会与主进程清理顺序冲突。
//
// 模块职责：为远程控制页面附着桌面 host 进程或远端会话 host，并登记端口供定向释放。
// 状态所有权：附件登记表与自增标识在工厂闭包内；端口在返回后归属调用方，关闭只经释放函数。
// 阅读顺序：先看三种上下文结构，再看本地与远端两条附着路径，最后看释放与两种定向清理。
import { BrowserWindow, MessageChannelMain } from "electron";
import type { MessagePortMain, UtilityProcess as ElectronUtilityProcess } from "electron";
import { HostMessageTypes, type RemoteUsageRemoteKind } from "@zcode/shared";

type WebRemoteControlSharedHostKind = "local" | "remote";

// WebRemoteControlSharedHostAttachContext 的 kind 决定走 attachLocalHost 还是 attachWorkspaceHost：remote 形态缺 remoteSessionId 时在 attachWorkspaceHost 首段抛 REMOTE_SESSION_MISSING，workspaceIdentity 是远端隔离的唯一依据、workspacePath 只是兜底键，initialTaskId 仅透传不参与路由，调用方必须构造完整结构，模块内不补默认值。
interface WebRemoteControlSharedHostAttachContext {
  kind: WebRemoteControlSharedHostKind;
  workspacePath: string;
  workspaceIdentity?: string;
  remoteSessionId?: string;
  initialTaskId?: string;
}

// WebRemoteControlSharedHostAttachment 同时给 entryId（desktop-host:${windowId} 或 remote-session-host:${remoteSessionId}，用于幂等）与 attachmentId（用于 releaseAttachment）；process/port 缺失上层就无法继续 postMessage，remoteKind 仅远端分支存在，port 所有权在返回后转移给调用方，结构不暴露内部 attachments 表。
interface WebRemoteControlSharedHostAttachment {
  entryId: string;
  attachmentId: string;
  process: ElectronUtilityProcess;
  port: MessagePortMain;
  remoteKind?: RemoteUsageRemoteKind;
}

// WebRemoteControlSharedHostError.code 是契约：createSharedHostError 按 DESKTOP_HOST_MISSING、REMOTE_SESSION_MISSING、REMOTE_WORKSPACE_IDENTITY_MISSING、REMOTE_WORKSPACE_IDENTITY_MISMATCH、REMOTE_SESSION_WINDOW_MISMATCH 区分缺失、身份与跨窗口冒用；统一成通用错误会让界面只能提示未知失败，message 面向开发者不直接展示给终端用户。
interface WebRemoteControlSharedHostError extends Error {
  code:
    | "DESKTOP_HOST_MISSING"
    | "REMOTE_WORKSPACE_IDENTITY_MISSING"
    | "REMOTE_WORKSPACE_IDENTITY_MISMATCH"
    | "REMOTE_SESSION_MISSING"
    | "REMOTE_SESSION_WINDOW_MISMATCH";
}

function createSharedHostError(
  code: WebRemoteControlSharedHostError["code"],
  message: string,
): WebRemoteControlSharedHostError {
  const error = new Error(message) as WebRemoteControlSharedHostError;
  error.code = code;
  return error;
}

export function createWebRemoteControlSharedHostAttachments(dependencies: {
  windowHostProcessMap: Map<number, ElectronUtilityProcess>;
  createMessageChannel?: () => { port1: MessagePortMain; port2: MessagePortMain };
  attachRemoteWorkspaceSessionHost: (params: {
    windowId: number;
    remoteSessionId: string;
    workspacePath: string;
    workspaceIdentity: string;
    workspaceKey: string;
    clientMode: "web-remote-replayable";
  }) => {
    process: ElectronUtilityProcess;
    port: MessagePortMain;
    remoteKind: RemoteUsageRemoteKind;
  };
  logger: {
    info: (...args: unknown[]) => void;
    warn: (...args: unknown[]) => void;
    error: (...args: unknown[]) => void;
  };
}) {
  let nextAttachmentId = 0;
  const attachments = new Map<
    string,
    {
      windowId: number;
      remoteSessionId?: string;
      port: MessagePortMain;
    }
  >();

  function createMessageChannel() {
    return dependencies.createMessageChannel?.() ?? new MessageChannelMain();
  }

  // attachLocalHost 先 BrowserWindow.fromId(windowId)?.webContents.id ?? windowId 换算成 webContents 标识再查 windowHostProcessMap：直接用 windowId 在部分窗口形态下取不到进程；查不到立即抛 DESKTOP_HOST_MISSING 而不返回空引用；createMessageChannel 的 port2 随 AttachServicePort 消息投递、port1 在 attachments.set 之后才归本模块接管，entryId 固定 desktop-host:${windowId}。
  function attachLocalHost(windowId: number): WebRemoteControlSharedHostAttachment {
    const hostProcessWindowId = BrowserWindow.fromId(windowId)?.webContents.id ?? windowId;
    const process = dependencies.windowHostProcessMap.get(hostProcessWindowId);
    if (!process) {
      throw createSharedHostError(
        "DESKTOP_HOST_MISSING",
        `未找到桌面窗口 host process，windowId=${windowId}`,
      );
    }

    const { port1, port2 } = createMessageChannel();
    const attachmentId = `shared-host-attachment-${++nextAttachmentId}`;
    process.postMessage(
      {
        type: HostMessageTypes.AttachServicePort,
        requestId: `shared-host-request-${nextAttachmentId}`,
        attachmentId,
        clientMode: "web-remote-replayable",
        scope: { kind: "local" },
      },
      [port2],
    );
    attachments.set(attachmentId, { windowId, port: port1 });
    return {
      entryId: `desktop-host:${windowId}`,
      attachmentId,
      process,
      port: port1,
    };
  }

  // attachWorkspaceHost 的检查顺序不可换：context.kind === "local" 直接转 attachLocalHost；remote 先判 !context.remoteSessionId 抛 REMOTE_SESSION_MISSING，再 trim workspaceIdentity 判空抛 REMOTE_WORKSPACE_IDENTITY_MISSING；workspaceKey 取 workspaceIdentity 而非 path，否则同一远端两种路径写法会各建隔离域；最后登记 { windowId, remoteSessionId, port } 并透传 attached.remoteKind。
  async function attachWorkspaceHost(
    windowId: number,
    context: WebRemoteControlSharedHostAttachContext,
  ): Promise<WebRemoteControlSharedHostAttachment> {
    if (context.kind === "local") {
      return attachLocalHost(windowId);
    }
    if (!context.remoteSessionId) {
      throw createSharedHostError(
        "REMOTE_SESSION_MISSING",
        "远程 workspace bridge 缺少 remoteSessionId。",
      );
    }
    const workspaceIdentity = context.workspaceIdentity?.trim();
    if (!workspaceIdentity) {
      throw createSharedHostError(
        "REMOTE_WORKSPACE_IDENTITY_MISSING",
        "远程 workspace bridge 缺少 workspaceIdentity，不能建立身份隔离。",
      );
    }
    const workspaceKey = workspaceIdentity || context.workspacePath;
    const attached = dependencies.attachRemoteWorkspaceSessionHost({
      windowId,
      remoteSessionId: context.remoteSessionId,
      workspacePath: context.workspacePath,
      workspaceIdentity,
      workspaceKey,
      clientMode: "web-remote-replayable",
    });
    const attachmentId = `shared-host-attachment-${++nextAttachmentId}`;
    attachments.set(attachmentId, {
      windowId,
      remoteSessionId: context.remoteSessionId,
      port: attached.port,
    });
    return {
      entryId: `remote-session-host:${context.remoteSessionId}`,
      attachmentId,
      process: attached.process,
      port: attached.port,
      remoteKind: attached.remoteKind,
    };
  }

  // releaseAttachment 先 attachments.get(attachmentId) 再 delete，第二次调用直接 return；delete 必须先于 attachment.port.close()，否则 close 期间的调用会重入；close 抛错只 logger.warn 带 attachmentId，绝不打断窗口销毁；释放不碰 process，host 进程生命周期归窗口管理。
  function releaseAttachment(attachmentId: string): void {
    const attachment = attachments.get(attachmentId);
    if (!attachment) {
      return;
    }
    attachments.delete(attachmentId);
    try {
      attachment.port.close();
    } catch (error) {
      dependencies.logger.warn("[web-remote-control] failed to close shared host attachment", {
        attachmentId,
        error,
      });
    }
  }

  function disposeWindow(windowId: number): void {
    for (const [attachmentId, attachment] of Array.from(attachments)) {
      if (attachment.windowId === windowId) {
        releaseAttachment(attachmentId);
      }
    }
  }

  function disposeRemoteSession(remoteSessionId: string): void {
    for (const [attachmentId, attachment] of Array.from(attachments)) {
      if (attachment.remoteSessionId === remoteSessionId) {
        releaseAttachment(attachmentId);
      }
    }
  }

  return {
    attachWorkspaceHost,
    releaseAttachment,
    disposeWindow,
    disposeRemoteSession,
  };
}
