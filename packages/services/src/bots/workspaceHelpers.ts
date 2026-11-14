// bots/workspaceHelpers.ts — Bot 工作区身份、允许列表与按值选择。
//
// INV-01 身份 key 统一为 workspaceIdentity?.trim() || workspacePath；所有去重、
//        过滤、比较都必须用这个口径。
// INV-02 allowedWorkspaces 为空或缺省等价于“全部允许”，归一化为单一标记。
// INV-03 配置里的 workspace id 在读取时解析成规范 id；解析不唯一时保留原值，
//        不做猜测。
// INV-04 按值选择支持 1 基序号、精确 id、大小写不敏感 label 与路径；label
//        必须唯一命中才返回，避免选错工作区。
import { ALL_BOT_WORKSPACES, type BotConfig, type BotWorkspaceRef } from "@zcode/shared";

// 身份 key 的唯一实现（见 INV-01）。
export function getWorkspaceKey(workspacePath: string, workspaceIdentity?: string): string {
  return workspaceIdentity?.trim() || workspacePath;
}

// 展示名取路径最后一段；根路径时回落原值。
export function getWorkspaceLabel(workspacePath: string): string {
  return workspacePath.split(/[\\/]/u).filter(Boolean).at(-1) ?? workspacePath;
}

// 构造对外的 workspace 引用；id 与身份同口径。
export function createWorkspaceRef(
  workspacePath: string,
  workspaceIdentity?: string,
): BotWorkspaceRef {
  const id = getWorkspaceKey(workspacePath, workspaceIdentity);
  return {
    id,
    // label 只用于展示，不参与身份。
    label: getWorkspaceLabel(workspacePath),
    workspacePath,
    workspaceIdentity,
  };
}

// “空”与显式全部标记都表示全部（见 INV-02）。
function isAllWorkspacesAllowed(allowedWorkspaces: readonly string[]): boolean {
  // isAllWorkspacesAllowed 认两种「全部」：空数组或显式含 ALL_BOT_WORKSPACES。
  return allowedWorkspaces.length === 0 || allowedWorkspaces.includes(ALL_BOT_WORKSPACES);
}

// 去空白、去重并折叠成单一全部标记。
export function normalizeAllowedWorkspaces(allowedWorkspaces: readonly string[]): string[] {
  // normalizeAllowedWorkspaces 先 trim 再用 filter(Boolean) 丢掉空串。
  const workspaceIds = allowedWorkspaces.map((item) => item.trim()).filter(Boolean);
    // 折叠成单一全部标记。
  if (isAllWorkspacesAllowed(workspaceIds)) {
    return [ALL_BOT_WORKSPACES];
  }
  return [...new Set(workspaceIds)];
}

// 权限判定：全部允许或命中列表。
export function isWorkspaceAllowed(
  workspaceId: string,
  allowedWorkspaces: readonly string[],
): boolean {
  // isWorkspaceAllowed 复用 isAllWorkspacesAllowed，判定口径与 filterAllowedWorkspaces 一致。
  return isAllWorkspacesAllowed(allowedWorkspaces) || allowedWorkspaces.includes(workspaceId);
}

// 列表过滤；全部允许时原样返回，避免复制。
export function filterAllowedWorkspaces(
  workspaces: BotWorkspaceRef[],
  allowedWorkspaces: readonly string[],
): BotWorkspaceRef[] {
  return isAllWorkspacesAllowed(allowedWorkspaces)
    // 全部允许直接返回原数组。
    ? workspaces
    : workspaces.filter((workspace) => allowedWorkspaces.includes(workspace.id));
}

// 把配置值解析成当前存在的规范 id。
function resolveCanonicalWorkspaceId(
  value: string | undefined,
  workspaces: readonly BotWorkspaceRef[],
): string | undefined {
  // value 可能为 undefined，先走可选链 trim 再判空，不在这里抛错。
  const trimmed = value?.trim();
    // 空输入视为“未指定”。
  if (!trimmed) {
    return undefined;
  }
  const exact = workspaces.find((workspace) => workspace.id === trimmed);
  // 先按 workspace.id 全等查找，命中即返回，不再进入身份与路径匹配。
  if (exact) return exact.id;
  // 其次按身份、根路径或路径匹配。
  const candidates = workspaces.filter(
    (workspace) =>
      workspace.workspaceIdentity === trimmed ||
      (!workspace.workspaceIdentity && workspace.rootPaths?.includes(trimmed)) ||
      workspace.workspacePath === trimmed,
  );
  // 不唯一时保留原值（见 INV-03）。
  return candidates.length === 1 ? candidates[0]!.id : trimmed;
}

// 配置加载时的归一化入口。
export function normalizeConfiguredAllowedWorkspaces(
  allowedWorkspaces: readonly string[],
  workspaces: readonly BotWorkspaceRef[],
): string[] {
  const normalized = normalizeAllowedWorkspaces(allowedWorkspaces);
  if (isAllWorkspacesAllowed(normalized)) {
    return [ALL_BOT_WORKSPACES];
  }
  return [
    ...new Set(
      normalized.map(
        (workspaceId) => resolveCanonicalWorkspaceId(workspaceId, workspaces) ?? workspaceId,
      ),
    ),
  ];
}

// 默认选中第一个允许的工作区；无可用返回 null。
export function firstAllowedWorkspace(
  workspaceRefs: BotWorkspaceRef[],
  bot: BotConfig,
): BotWorkspaceRef | null {
  const allowedWorkspaces = filterAllowedWorkspaces(workspaceRefs, bot.allowedWorkspaces);
  return allowedWorkspaces[0] ?? null;
}

// label 比较口径：trim + 小写。
function normalizeText(value: string): string {
  return value.trim().toLowerCase();
}

// 用户输入解析，用于 /workspace 切换（见 INV-04）。
export function resolveWorkspaceByValue(
  workspaceRefs: BotWorkspaceRef[],
  value: string,
  allowedIds: string[],
): BotWorkspaceRef | null {
  const trimmed = value.trim();
  // 纯数字按 1 基序号处理。
  const index = Number.parseInt(trimmed, 10);
  const workspaces = filterAllowedWorkspaces(workspaceRefs, allowedIds);
    // 序号越界返回 null，不回落到第一项。
  if (Number.isFinite(index) && index > 0) {
    return workspaces[index - 1] ?? null;
  }
  // 精确 id 未命中后再按 label/路径匹配。
  const normalized = normalizeText(trimmed);
  const exact = workspaces.find((workspace) => workspace.id === trimmed);
  if (exact) return exact;
  // 最后按 label/路径匹配，要求唯一。
  const matches = workspaces.filter(
    (workspace) =>
      normalizeText(workspace.label) === normalized ||
      workspace.workspacePath === trimmed ||
      getWorkspaceKey(workspace.workspacePath, workspace.workspaceIdentity) === trimmed,
  );
  // 多命中视为歧义，返回 null 让用户改用序号。
  return matches.length === 1 ? matches[0]! : null;
}
