// INV-01 拖拽 MIME 固定：守住位置 WORKSPACE_FILE_DRAG_MIME；改错故障 与外部文件拖拽混淆。
// INV-02 两类自定义事件名固定：守住位置 两个事件常量；改错故障 监听方收不到事件。
// INV-03 载荷只认文件与目录：守住位置 type 判断；改错故障 其它类型混入提及。
// INV-04 五个必填字段全为字符串：守住位置 联合校验；改错故障 非字符串进入面板。
// INV-05 可选身份去空白后才保留：守住位置 workspaceIdentity 判断；改错故障 空身份被当有效。
// INV-06 解析失败一律返回空：守住位置 末尾 catch；改错故障 坏数据中断整个拖拽。
// INV-07 读取前先查类型存在：守住位置 hasWorkspaceFileDragPayload；改错故障 取到空串再解析。
// INV-08 拖拽状态跨窗口广播：守住位置 dispatchWorkspaceFileDragState；改错故障 遮罩不消失。
// INV-09 无 window 时静默返回：守住位置 环境判断；改错故障 服务端渲染直接报错。
// INV-10 加入聊天事件可取消：守住位置 cancelable 选项；改错故障 面板无法接管拖放。
// INV-11 返回值表示是否已处理：守住位置 取反 dispatchEvent；改错故障 重复插入同一条提及。
// INV-12 跨工作区回退绝对路径：守住位置 sameWorkspace 三元；改错故障 提及指向不存在的相对路径。
// INV-13 同工作区用相对路径：守住位置 mentionTarget；改错故障 提及文本过长且难读。
// INV-14 身份为空与缺省等价：守住位置 空串归一；改错故障 同工作区被误判跨区。
// INV-15 提及结构只含必要字段：守住位置 data 三键；改错故障 冗余字段进入协议。
// INV-16 Markdown 由统一函数生成：守住位置 buildFileMentionMarkdown；改错故障 提及渲染不一致。
// INV-17 本模块不持有拖拽状态：守住位置 纯函数集合；改错故障 多面板共享脏状态。
// INV-18 事件名集中导出：守住位置 常量导出；改错故障 各处硬编码字符串漂移。
//
// 模块职责：工作区文件拖拽载荷的序列化、解析与提及构造。
// 状态所有权：无状态；拖拽视觉状态由各订阅方自行持有。
// 阅读顺序：先看常量与载荷类型，再读解析与事件，最后看提及构造。
import { buildFileMentionMarkdown } from "@/mentions/mentionMarkdown.js";

export const WORKSPACE_FILE_DRAG_MIME = "application/x-zcode-workspace-file";
export const WORKSPACE_FILE_ADD_TO_CHAT_EVENT = "zcode:add-workspace-file-to-chat";
export const WORKSPACE_FILE_DRAG_STATE_EVENT = "zcode:workspace-file-drag-state";

export interface WorkspaceFileDragPayload {
  type: "file" | "directory";
  workspacePath: string;
  workspaceIdentity?: string;
  path: string;
  relativePath: string;
  name: string;
}

interface WorkspaceFileComposerMention {
  markdown: string;
  value: string;
  data: {
    kind: WorkspaceFileDragPayload["type"];
    path: string;
    relativePath: string;
  };
}

interface WorkspaceFileDragStateDetail {
  dragging: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function serializeWorkspaceFileDragPayload(payload: WorkspaceFileDragPayload): string {
  return JSON.stringify(payload);
}

// rawPayload 为空串或 undefined 时 parseWorkspaceFileDragPayload() 直接返回 null。
// JSON.parse 结果必须通过 isRecord() 判定为对象。
// 先校验 type，再逐个检查 workspacePath、path、relativePath、name 是否为 string。
// workspaceIdentity 去空白后仍有值才写入返回对象。
// 返回对象逐字段重建，未列入的字段被丢弃。
// JSON.parse 抛错由 catch 兜住，返回 null。
export function parseWorkspaceFileDragPayload(
  rawPayload: string | null | undefined,
): WorkspaceFileDragPayload | null {
  if (!rawPayload) {
    return null;
  }

  try {
    const parsed: unknown = JSON.parse(rawPayload);
    if (!isRecord(parsed)) {
      return null;
    }

    const type = parsed.type;
    const workspacePath = parsed.workspacePath;
    const path = parsed.path;
    const relativePath = parsed.relativePath;
    const name = parsed.name;
    const workspaceIdentity = parsed.workspaceIdentity;

    if (
      (type !== "file" && type !== "directory") ||
      typeof workspacePath !== "string" ||
      typeof path !== "string" ||
      typeof relativePath !== "string" ||
      typeof name !== "string"
    ) {
      return null;
    }

    return {
      type,
      workspacePath,
      path,
      relativePath,
      name,
      ...(typeof workspaceIdentity === "string" && workspaceIdentity.trim()
        ? { workspaceIdentity }
        : {}),
    };
  } catch {
    return null;
  }
}

// 先用 hasWorkspaceFileDragPayload() 确认 WORKSPACE_FILE_DRAG_MIME 存在。
// 再读取指定 MIME 数据。
// 两条入口都调用 parseWorkspaceFileDragPayload()，不各自解析。
// 该函数不写回 dataTransfer。
// 返回空表示不是本应用拖拽。
// 供放置处理器直接使用。
export function readWorkspaceFileDragPayload(
  dataTransfer: DataTransfer,
): WorkspaceFileDragPayload | null {
  if (!hasWorkspaceFileDragPayload(dataTransfer)) {
    return null;
  }

  return parseWorkspaceFileDragPayload(dataTransfer.getData(WORKSPACE_FILE_DRAG_MIME));
}

export function hasWorkspaceFileDragPayload(dataTransfer: DataTransfer): boolean {
  return Array.from(dataTransfer.types).includes(WORKSPACE_FILE_DRAG_MIME);
}

export function isWorkspaceFileDragStateEvent(
  event: Event,
): event is CustomEvent<WorkspaceFileDragStateDetail> {
  return event.type === WORKSPACE_FILE_DRAG_STATE_EVENT;
}

export function dispatchWorkspaceFileDragState(dragging: boolean): void {
  if (typeof window === "undefined") {
    return;
  }

  window.dispatchEvent(
    new CustomEvent<WorkspaceFileDragStateDetail>(WORKSPACE_FILE_DRAG_STATE_EVENT, {
      detail: { dragging },
    }),
  );
}

export function isWorkspaceFileAddToChatEvent(
  event: Event,
): event is CustomEvent<WorkspaceFileDragPayload> {
  return event.type === WORKSPACE_FILE_ADD_TO_CHAT_EVENT;
}

// 无 window 时返回未处理。
// 事件声明为可取消。
// 载荷原样放入 detail。
// 被取消时 dispatchWorkspaceFileAddToChat() 仍返回 true，视为已处理。
// 返回值是 boolean，供调用方决定是否继续。
// 该函数只读 payload，不修改 dataTransfer。
export function dispatchWorkspaceFileAddToChat(payload: WorkspaceFileDragPayload): boolean {
  if (typeof window === "undefined") {
    return false;
  }

  const event = new CustomEvent(WORKSPACE_FILE_ADD_TO_CHAT_EVENT, {
    cancelable: true,
    detail: payload,
  });
  return !window.dispatchEvent(event);
}

function isWorkspaceFilePayloadForWorkspace(
  payload: Pick<WorkspaceFileDragPayload, "workspacePath" | "workspaceIdentity">,
  workspacePath: string,
  workspaceIdentity?: string,
): boolean {
  return (
    payload.workspacePath === workspacePath &&
    (payload.workspaceIdentity ?? "") === (workspaceIdentity ?? "")
  );
}

// 先由 isWorkspaceFilePayloadForWorkspace() 判断是否同一工作区。
// 同区取 payload.relativePath。
// 跨区回退 payload.path。
// Markdown 交由统一函数生成。
// data 只保留三个字段。
export function createWorkspaceFileComposerMention(
  payload: WorkspaceFileDragPayload,
  workspacePath: string,
  workspaceIdentity?: string,
): WorkspaceFileComposerMention {
  const sameWorkspace = isWorkspaceFilePayloadForWorkspace(
    payload,
    workspacePath,
    workspaceIdentity,
  );
  const mentionTarget = sameWorkspace ? payload.relativePath : payload.path;

  return {
    markdown: buildFileMentionMarkdown(mentionTarget, payload.name, payload.type),
    value: mentionTarget,
    data: {
      kind: payload.type,
      path: payload.path,
      relativePath: mentionTarget,
    },
  };
}
