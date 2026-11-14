// INV-01 设置读取永不抛错：守住位置 readStartupSettings 的 catch；改错故障 损坏的 settings.json 阻断启动。
// INV-02 非法结构回落默认：守住位置 safeParse 分支；改错故障 半截配置进入窗口引导。
// INV-03 预热上限为 1：守住位置 STARTUP_AGENT_WARMUP_LIMIT；改错故障 每个窗口常驻多份 Agent 内存。
// INV-04 只在本地会话预热：守住位置 activeSession.kind 判断；改错故障 远程工作区也起本地 CLI。
// INV-05 可用性三重校验：守住位置 stat + isDirectory + access；改错故障 无权限目录被当可用。
// INV-06 不可用只让出路径：守住位置 unavailableWorkspacePath；改错故障 直接清空用户上次工作区。
// INV-07 cwd 必须有真实目录：守住位置 mkdir(conversationWorkspaceDir)；改错故障 CLI 在发存储帧前退出。
// INV-08 backing workspace 不当项目：守住位置 initialWorkspacePurpose: "conversation"；改错故障 凭空出现 ZCodeProject。
// INV-09 新字段优先：守住位置 lastActiveWorkspace 判断；改错故障 旧多标签状态覆盖当前单工作区。
// INV-10 索引夹取到合法区间：守住位置 min/max；改错故障 标签数变少时取到 undefined。
// INV-11 远程会话不预热：守住位置 localActiveSessionIndex 分支；改错故障 远程活动项也产出预热目标。
// INV-12 返回结构按需带字段：守住位置 条件展开；改错故障 传 undefined 字段覆盖默认值。
// INV-13 打开工作区固定为项目用途：守住位置 createOpenWorkspaceStartupBootstrap；改错故障 用户打开的目录被标成会话目录。
// INV-14 读取顺序只影响日志：守住位置 logger?.warn/info；改错故障 日志失败改变返回值。
//
// 模块职责：把持久化设置翻译成首窗引导参数，决定恢复哪个工作区与预热哪个 cwd。
// 阅读顺序：先看设置读取容错，再看会话选取，最后看三条返回分支。
import { constants } from "node:fs";
import { access, mkdir, readFile, stat } from "node:fs/promises";
import {
  appSettingsSchema,
  formatZodError,
  resolveStartupLocalWorkspaceSessionIndex,
  type WorkspacePurpose,
} from "@zcode/shared";

interface StartupWorkspaceLogger {
  info?: (...args: unknown[]) => void;
  warn?: (...args: unknown[]) => void;
}

// 任何读取异常都必须退化为默认设置。
async function readStartupSettings(settingsFile: string, logger?: StartupWorkspaceLogger) {
  try {
    const raw = await readFile(settingsFile, "utf-8");
    const parsed = JSON.parse(raw);
    const result = appSettingsSchema.safeParse(parsed);

    // 结构非法与文件缺失必须走同一回落。
    if (!result.success) {
      logger?.warn?.(
        "[startup-workspace] invalid settings file, falling back to default workspace:",
        formatZodError(result.error),
      );
      return appSettingsSchema.parse({});
    }

    return result.data;
  } catch {
    return appSettingsSchema.parse({});
  }
}

export interface StartupWorkspaceWarmupTarget {
  workspacePath: string;
  workspaceIdentity?: string;
}

// 修复原因：会话 CLI 没有 idle 回收，启动预热 3 个会让每个窗口常驻 3 份 Agent 进程内存；
// 切到最近项目的冷启动收益抵不上常驻成本，收敛为只预热 active workspace。
// 与 @zcode/protocol 的 init-local `agentWarmupTargets.max(1)` 保持一致。
// STARTUP_AGENT_WARMUP_LIMIT 与协议上限保持一致。
export const STARTUP_AGENT_WARMUP_LIMIT = 1;

// 引导参数全部可选，缺省由 Host 决定。
export interface StartupWindowBootstrap {
  restoreSession?: boolean;
  initialWorkspacePath?: string;
  initialWorkspacePurpose?: WorkspacePurpose;
  unavailableWorkspacePath?: string;
  agentWarmupTargets?: StartupWorkspaceWarmupTarget[];
}

// 目录必须存在且可读可进入才算可用。
async function isAvailableWorkspaceDirectory(workspacePath: string): Promise<boolean> {
  try {
    const workspaceStat = await stat(workspacePath);
    if (!workspaceStat.isDirectory()) {
      return false;
    }
    // 权限不足必须按不可用处理。
    await access(workspacePath, constants.R_OK | constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

// 从 lastWorkspaceSession 里取当前活动项。
function resolvePersistedActiveSession(
  sessions: NonNullable<ReturnType<typeof appSettingsSchema.parse>["lastWorkspaceSession"]>,
  lastActiveTabIndex: number | undefined,
) {
  if (sessions.length === 0) {
    return undefined;
  }
  // 索引必须夹取，容忍标签数缩减。
  const activeIndex = Math.min(Math.max(lastActiveTabIndex ?? 0, 0), sessions.length - 1);
  return sessions[activeIndex];
}

// 用户主动打开目录时用途固定为项目。
export function createOpenWorkspaceStartupBootstrap(workspacePath: string): StartupWindowBootstrap {
  return {
    initialWorkspacePath: workspacePath,
    initialWorkspacePurpose: "project",
    agentWarmupTargets: [{ workspacePath }],
  };
}

// 启动恢复的唯一决策点。
export async function resolveStartupWindowBootstrap({
  settingsFile,
  conversationWorkspaceDir,
  logger,
}: {
  settingsFile: string;
  conversationWorkspaceDir: string;
  logger?: StartupWorkspaceLogger;
}): Promise<StartupWindowBootstrap> {
  const settings = await readStartupSettings(settingsFile, logger);
  // 新字段 lastActiveWorkspace 存在时不再读旧多标签列表。
  const sessions =
    settings.lastActiveWorkspace === undefined
      ? (settings.lastWorkspaceSession ?? [])
      : settings.lastActiveWorkspace
        ? [settings.lastActiveWorkspace]
        : [];
  const activeIndex = settings.lastActiveWorkspace === undefined ? settings.lastActiveTabIndex : 0;

  if (sessions.length > 0) {
    const persistedActiveSession = resolvePersistedActiveSession(sessions, activeIndex);
    const unavailableWorkspacePath =
      persistedActiveSession?.kind === "local" &&
      !(await isAvailableWorkspaceDirectory(persistedActiveSession.workspacePath))
        ? persistedActiveSession.workspacePath
        : undefined;
    // 不可用必须只告警，仍保留原路径供读史。
    if (unavailableWorkspacePath) {
      // 上次激活 workspace 被移动或删除后，Agent 仍需保留原业务路径读取历史，
      // 但子进程 cwd 必须落在真实存在的目录；conversation backing workspace 只承担 cwd 兜底。
      await mkdir(conversationWorkspaceDir, { recursive: true });
      logger?.warn?.(
        "[startup-workspace] active local workspace unavailable; using read-only restore:",
        unavailableWorkspacePath,
      );
    }
    // 只有本地会话能产出预热目标。
    const localActiveSessionIndex = resolveStartupLocalWorkspaceSessionIndex(sessions, activeIndex);
    const activeSession =
      localActiveSessionIndex == null ? undefined : sessions[localActiveSessionIndex];
    if (activeSession?.kind === "local") {
      // 项目/最近目录不再决定 Agent 生命周期，只预热上次活动执行目录。
      const agentWarmupTargets = [{ workspacePath: activeSession.workspacePath }];
      return {
        ...(unavailableWorkspacePath ? { unavailableWorkspacePath } : {}),
        agentWarmupTargets,
      };
    }
    // 远程活动项没有本地预热目标，Host 会用此 app-owned cwd 准备会话库。
    // 切换数据根后该目录尚不存在；必须在交给 Host 前创建，否则 CLI 在发出存储帧前即退出。
    await mkdir(conversationWorkspaceDir, { recursive: true });
    return unavailableWorkspacePath ? { unavailableWorkspacePath } : {};
  }

  // UI 可以没有项目，但 Agent 必须始终有真实 cwd。首次启动统一预热
  // app-managed conversation backing workspace，不能再创建会被误认成项目的 ZCodeProject。
  await mkdir(conversationWorkspaceDir, { recursive: true });
  logger?.info?.("[startup-workspace] using conversation workspace:", conversationWorkspaceDir);
  return {
    initialWorkspacePath: conversationWorkspaceDir,
    initialWorkspacePurpose: "conversation",
    agentWarmupTargets: [{ workspacePath: conversationWorkspaceDir }],
  };
}
