import type { TuiSelection, TuiSelectionItem } from "@zcode/tui";
import type {
  CommandCenterCheckpoint,
  CommandCenterSession,
  CommandCenterTarget,
} from "./types.js";
import { formatTime, shortId, shortText } from "./utils.js";

// 会话/回滚选择器统一贴在 composer 下方，保持输入区焦点与视觉位置一致。
const COMPOSER_SELECTION_PLACEMENT = "composer";

// 构造会话恢复选择器：每项 command 为 `/resume <id>`，keywords 覆盖目录/标题/父会话便于过滤；
// 空列表由 emptyMessage 呈现，不返回 undefined。
export function buildSessionSelection(sessions: CommandCenterSession[]): TuiSelection {
  return {
    emptyMessage: "No saved sessions found for this directory.",
    help: "Type to filter, Up/Down choose, Enter resumes, Esc cancels",
    items: sessions.map(sessionToSelectionItem),
    placement: COMPOSER_SELECTION_PLACEMENT,
    prompt: "Choose a session to resume.",
    title: "Resume Session",
  };
}

// 单条会话项：parentId 存在时标记为 fork（显示父会话短 id），否则标记 root；
// meta 展示更新时间与派生关系，secondary 展示短 id 与目录。
function sessionToSelectionItem(session: CommandCenterSession): TuiSelectionItem {
  const forkMeta = session.parentId ? `fork of ${shortId(session.parentId)}` : "root";
  return {
    command: `/resume ${session.id}`,
    id: session.id,
    keywords: [session.directory, session.title, session.parentId ?? ""],
    meta: `${formatTime(session.updatedAt)} | ${forkMeta}`,
    primary: session.title || session.id,
    secondary: `${shortId(session.id)} | ${session.directory}`,
  };
}

// 构造检查点选择器（fork/rewind 共用）：动作决定命令动词与标题；
// rewind 贴 composer 展示，fork 保持默认位置（fork 会切换会话，语义更重）。
export function buildCheckpointSelection(
  action: "fork" | "rewind",
  checkpoints: CommandCenterCheckpoint[],
): TuiSelection {
  const verb = action === "fork" ? "fork from" : "rewind to";
  return {
    emptyMessage: "No workspace checkpoints are available yet.",
    help: `Type to filter, Up/Down choose, Enter ${verb}, Esc cancels`,
    items: checkpoints.map((checkpoint) => checkpointToSelectionItem(action, checkpoint)),
    ...(action === "rewind" ? { placement: COMPOSER_SELECTION_PLACEMENT } : {}),
    prompt: `Choose a checkpoint to ${verb}.`,
    title: action === "fork" ? "Fork From Checkpoint" : "Rewind To Checkpoint",
  };
}

// 单条检查点项：fileCount 缺失显示 unknown files（单数/复数按数量）；被 compact 覆盖时
// 附 compact 边界 id；preview 缺失回退为消息短 id，保证主行始终有可读文本。
function checkpointToSelectionItem(
  action: "fork" | "rewind",
  checkpoint: CommandCenterCheckpoint,
): TuiSelectionItem {
  const fileCount =
    checkpoint.fileCount === undefined
      ? "unknown files"
      : `${checkpoint.fileCount} file${checkpoint.fileCount === 1 ? "" : "s"}`;
  const compact = checkpoint.coveredByCompact
    ? ` | compact ${checkpoint.compactBoundaryId ?? "covered"}`
    : "";
  const preview = checkpoint.preview ?? `message ${shortId(checkpoint.messageId)}`;
  return {
    command: `/${action} ${checkpoint.checkpointId}`,
    id: checkpoint.checkpointId,
    keywords: [
      checkpoint.messageId,
      checkpoint.scope,
      checkpoint.compactBoundaryId ?? "",
      checkpoint.preview ?? "",
    ],
    meta: `${fileCount} | ${formatTime(checkpoint.createdAt)}${compact}`,
    primary: preview,
    secondary: shortId(checkpoint.checkpointId),
  };
}

// 构造「覆盖目标」确认选择器：唯一项执行 `/goal replace <objective>`；
// meta 截断展示旧目标、secondary 截断展示新目标，避免长文本撑破列表。
export function buildTargetReplaceSelection(
  existing: CommandCenterTarget,
  objective: string,
): TuiSelection {
  return {
    emptyMessage: "No goal replacement actions are available.",
    help: "Enter replaces the current goal, Esc cancels",
    items: [
      {
        command: `/goal replace ${objective}`,
        id: "replace-goal",
        keywords: [objective, existing.objective],
        meta: `Current: ${shortText(existing.objective, 80)}`,
        primary: "Replace current goal",
        secondary: shortText(objective, 100),
      },
    ],
    prompt: "Replace the current goal?",
    title: "Replace Goal",
  };
}
