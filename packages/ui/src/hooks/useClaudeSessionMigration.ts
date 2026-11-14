// INV-01 只有桌面端才声明迁移能力，Web 端固定返回不支持并给出桌面专属原因；守住位置：supportState 的 useMemo；改错故障：Web 用户看到永远失败的迁移入口
// INV-02 能力判定只依赖 isDesktop，工作区仅作筛选条件不再是可用前提；守住位置：supportState 的依赖数组；改错故障：未选工作区时入口被误禁用
// INV-03 扫描与导入前必须再次校验 supported，任何入口都不能绕过；守住位置：scan 与 importSessions 的首个分支；改错故障：Web 端直接调用服务并抛出未捕获错误
// INV-04 待导入会话数为零时直接返回 null，不进入 loading 也不发请求；守住位置：importSessions 的入口判断；改错故障：空请求把界面卡在导入中
// INV-05 筛选模式为 current 却没有工作区时必须归一化为 all；守住位置：normalizeWorkspaceFilterMode 与 setWorkspaceFilterMode；改错故障：界面显示当前工作区却检索全部历史
// INV-06 扫描上限取值 unlimited 表示不限，其余输入必须落在 1 到 500 之间；守住位置：resolveClaudeMigrationScanLimit；改错故障：超大值打爆扫描，非法值静默返回空列表
// INV-07 时间范围只参与计算 modifiedSince，all 必须传 undefined 而不是 0；守住位置：resolveModifiedSince；改错故障：all 被当成 1970 起点，历史被整体过滤
// INV-08 时间窗口在每次调用时按当下时间回推，不能提前算成模块级常量；守住位置：resolveModifiedSince 内部的取时；改错故障：长驻页面窗口不前进，新会话扫不到
// INV-09 扫描成功后勾选集只保留仍出现在新结果中的会话；守住位置：scan 内对 setSelectedSessionIds 的过滤；改错故障：不可见的旧会话被带入导入请求
// INV-10 扫描失败只写 scanError 并保留既有候选，不清空列表；守住位置：scan 的 catch 分支；改错故障：一次网络抖动把用户已看到的列表清空
// INV-11 扫描进行标记必须在 finally 中复位，成功与失败都要回到可再次扫描；守住位置：scan 的 finally；改错故障：失败后按钮永久禁用
// INV-12 扫描错误与导入错误是两个独立状态，互不覆盖；守住位置：scanError 与 importError 的写入点；改错故障：扫描失败的提示被导入成功冲掉
// INV-13 导入完成后把成功、跳过、失败三类会话统一从勾选中剔除；守住位置：handledSessionIds 与随后的过滤；改错故障：已处理会话仍被勾选，重复导入
// INV-14 导入失败返回 null 并保留上次成功摘要，不清空 lastImportResult；守住位置：importSessions 的 catch；改错故障：一次失败抹掉上一轮成功结果
// INV-15 导入进行标记同样在 finally 复位，异常路径不得跳过；守住位置：importSessions 的 finally；改错故障：失败后无法再次发起导入
// INV-16 只有存在成功导入时才建标签并失效任务缓存；守住位置：result 中 imported 长度分支；改错故障：空导入也触发整轮刷新与新标签页
// INV-17 缓存失效按受影响工作区精确作用域，不做全量刷新；守住位置：invalidateTaskQueryCacheByScopes 调用处；改错故障：无关工作区一起重查，任务列表闪烁
// INV-18 工作区路径与身份随筛选模式派生，current 之外一律为 undefined；守住位置：effectiveWorkspacePath 与 effectiveWorkspaceIdentity；改错故障：all 模式仍带工作区，结果被错误收窄
// INV-19 本文件没有 effect 清理，异步回调在卸载后仍可能写状态；守住位置：全部异步回调；改错故障：卸载后写状态触发警告并落在已丢弃的实例上
//
// 本 hook 是 Claude 原生历史迁移的唯一编排层，能力判定、扫描、勾选与导入都在这里收敛。
// 迁移是一次性动作，读的是本机 ~/.claude/projects，改动前先想清楚失败时界面停在哪个状态。
import { useCallback, useMemo, useState } from "react";
import type {
  ZCodeImportSessionsResult,
  ZCodeImportableSessionCandidate,
} from "@zcode/shared";
import { logger } from "@/logger.js";
import { useZCodeTaskService } from "@/hooks/useZCodeTaskService.js";
import { useTabStoreApi } from "@/store/TabStoreProvider.js";
import { invalidateTaskQueryCacheByScopes } from "@/store/taskQueryCacheStore.js";

export type ClaudeMigrationRange = "all" | "7d" | "30d" | "90d";
type ClaudeMigrationWorkspaceFilterMode = "all" | "current";

// 默认扫描 DEFAULT_LIMIT=100 条，是首次打开迁移面板时的量级基线。
// 上限 500，否则一次拉太多会把主线程与日志打满 [权衡]。
const DEFAULT_LIMIT = 100;
const MAX_SCAN_LIMIT = 500;
export const UNLIMITED_SCAN_LIMIT_INPUT = "unlimited";

// 三种时间范围映射成毫秒时长，all 被类型排除在表外
// 新增范围要先补这张表再补分支，否则取值会落到 undefined
const RANGE_TO_DURATION_MS: Record<Exclude<ClaudeMigrationRange, "all">, number> = {
  "7d": 7 * 24 * 60 * 60 * 1000,
  "30d": 30 * 24 * 60 * 60 * 1000,
  "90d": 90 * 24 * 60 * 60 * 1000,
};

// 每次调用都用当下时间回推窗口，不能缓存成模块级常量
// all 返回 undefined 表示不限时间，与传 0 的语义完全不同 [失败路径]
function resolveModifiedSince(range: ClaudeMigrationRange): number | undefined {
  if (range === "all") {
    return undefined;
  }

  // 返回绝对毫秒时间戳，由服务端按文件 mtime 比较；本机时钟偏差会让整个时间窗口前后平移。
  return Date.now() - RANGE_TO_DURATION_MS[range];
}

// unlimited 哨兵值转成 undefined，表示交给后端不限条数
// 非法或非正输入回落到默认值，合法值再夹到 500 以内 [权衡]
export function resolveClaudeMigrationScanLimit(limitInput: string): number | undefined {
  if (limitInput === UNLIMITED_SCAN_LIMIT_INPUT) {
    return undefined;
  }

  const parsed = Number.parseInt(limitInput.trim(), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return DEFAULT_LIMIT;
  }

  return Math.min(parsed, MAX_SCAN_LIMIT);
}

export interface ClaudeSessionMigrationSupportState {
  supported: boolean;
  reason?: "desktopOnly";
}

// current 但没有工作区时降级为 all，避免筛出必然为空的列表
// 归一化只发生在派生与写入两处，读侧不再做二次判断 [权衡]
function normalizeWorkspaceFilterMode(
  mode: ClaudeMigrationWorkspaceFilterMode,
  workspacePath: string | null,
): ClaudeMigrationWorkspaceFilterMode {
  if (mode === "current" && !workspacePath) {
    return "all";
  }

  return mode;
}

// params.workspacePath 可为空，identity 可选；isDesktop 决定迁移能力是否开放，否则整个面板会退化成只读。
// 整个 hook 只有一份 useState 状态，没有 effect 与跨渲染 ref 缓存，重渲染会重新执行全部回调。
// 异步回调在卸载后仍可能写状态，防护责任落在调用方的挂载生命周期 [失败路径]。
export function useClaudeSessionMigration(params: {
  workspacePath: string | null;
  workspaceIdentity?: string;
  isDesktop?: boolean;
}) {
  // 服务随工作区路径与身份重建，切换工作区会拿到新实例
  // 它进入扫描与导入的依赖数组，实例变化会重建这两个回调 [资源]
  const zcodeTaskService = useZCodeTaskService(
    params.workspacePath ?? undefined,
    undefined,
    params.workspaceIdentity,
  );
  const tabStoreApi = useTabStoreApi();
  const [workspaceFilterModeState, setWorkspaceFilterModeState] =
    useState<ClaudeMigrationWorkspaceFilterMode>("all");
  const [range, setRange] = useState<ClaudeMigrationRange>("30d");
  const [limitInput, setLimitInput] = useState(String(DEFAULT_LIMIT));
  const [candidates, setCandidates] = useState<ZCodeImportableSessionCandidate[]>([]);
  const [selectedSessionIds, setSelectedSessionIds] = useState<string[]>([]);
  const [scanError, setScanError] = useState<string | null>(null);
  const [importError, setImportError] = useState<string | null>(null);
  const [lastImportResult, setLastImportResult] =
    useState<ZCodeImportSessionsResult | null>(null);
  // isScanning 是扫描进行中标记，驱动按钮禁用与转圈，与 isImporting 彼此独立。
  // 两个标记分开，才能表达扫描与导入交错时的界面状态机，否则会互相覆盖成 loading。
  const [isScanning, setIsScanning] = useState(false);
  const [isImporting, setIsImporting] = useState(false);

  // workspaceFilterMode 由本地状态与 params.workspacePath 共同派生。
  // 派生而不回写状态，否则工作区消失时显示会与实际过滤不一致 [权衡]。
  const workspaceFilterMode = useMemo(
    () => normalizeWorkspaceFilterMode(workspaceFilterModeState, params.workspacePath),
    [workspaceFilterModeState, params.workspacePath],
  );

  // 只有 current 模式才把路径下发给服务，all 模式显式传 undefined
  // 路径为空时同样归为 undefined，让两种输入落到同一条分支
  const effectiveWorkspacePath = useMemo(
    () => (workspaceFilterMode === "current" ? params.workspacePath ?? undefined : undefined),
    [workspaceFilterMode, params.workspacePath],
  );
  // 身份只在 current 模式透传，并且先去掉首尾空白
  // 空串转成 undefined，避免把空身份当成真实隔离键 [资源]
  const effectiveWorkspaceIdentity = useMemo(
    () =>
      workspaceFilterMode === "current"
        ? params.workspaceIdentity?.trim() || undefined
        : undefined,
    [params.workspaceIdentity, workspaceFilterMode],
  );

  // 能力判定只依赖桌面标记，是本 hook 中最便宜也最关键的派生
  // 工作区从可用前提降级为筛选条件，判定里不再看路径
  // 依赖数组只有一项，多写会让能力状态无谓重算 [权衡]
  const supportState = useMemo<ClaudeSessionMigrationSupportState>(() => {
    // 关键业务逻辑：Claude 原生历史迁移读取的是“当前机器上的 ~/.claude/projects”。
    // 因此这里只拦 web 场景；workspace 现在只是可选筛选条件，不再决定能力是否可用。
    if (!params.isDesktop) {
      return {
        supported: false,
        reason: "desktopOnly",
      };
    }

    return {
      supported: true,
    };
  }, [params.isDesktop]);

  const scanLimit = useMemo(
    () => resolveClaudeMigrationScanLimit(limitInput),
    [limitInput],
  );

  const setWorkspaceFilterMode = useCallback(
    (mode: ClaudeMigrationWorkspaceFilterMode) => {
      setWorkspaceFilterModeState(normalizeWorkspaceFilterMode(mode, params.workspacePath));
    },
    [params.workspacePath],
  );

  // 勾选切换走函数式更新，永远基于前一状态算出新数组
  // 空依赖让它保持稳定引用，列表行不会因父级重渲染而重挂
  const toggleSessionSelection = useCallback((sessionId: string) => {
    setSelectedSessionIds((previous) => {
      if (previous.includes(sessionId)) {
        return previous.filter((current) => current !== sessionId);
      }

      return [...previous, sessionId];
    });
  }, []);

  const selectAllSessions = useCallback(() => {
    // 全选是覆盖而非并集，重复点击保持幂等；候选为空时等效于清空所有勾选。
    setSelectedSessionIds(candidates.map((candidate) => candidate.sessionId));
  }, [candidates]);

  const clearSelectedSessions = useCallback(() => {
    setSelectedSessionIds([]);
  }, []);

  // 扫描入口先看能力，再置进行标记并清空上一次错误
  // 这里没有并发去重，连点会发多次请求，后到的结果覆盖先到的 [并发]
  // 结果落地后同步修剪勾选，让列表与选择保持一致 [事务]
  const scan = useCallback(async () => {
    if (!supportState.supported) {
      return;
    }

    setIsScanning(true);
    setScanError(null);

    try {
      logger.info(
        `[Migration] 开始扫描 Claude 原生历史 workspaceFilter=${effectiveWorkspacePath ?? "all"} range=${range} limit=${scanLimit ?? "unlimited"}`,
      );
      // 扫描前先把 effectiveWorkspacePath、identity 与 limit 组装成一次请求。
      // 后两者用条件展开，缺失时不下发空字段，否则后端会把空串当有效值 [权衡]。
      const nextCandidates = await zcodeTaskService.scanImportableClaudeSessions({
        workspacePath: effectiveWorkspacePath,
        ...(effectiveWorkspaceIdentity
          ? { workspaceIdentity: effectiveWorkspaceIdentity }
          : {}),
        modifiedSince: resolveModifiedSince(range),
        ...(scanLimit === undefined ? {} : { limit: scanLimit }),
      });
      setCandidates(nextCandidates);
      // 关键业务逻辑：重扫后只保留仍然可见的勾选项。
      // 这样用户调筛选条件或刷新结果时，不会把已经不在当前列表里的旧 session 混进导入请求。
      // 重扫后只保留仍在新结果里的勾选，其余静默丢弃
      // 过滤基于本次返回值而非旧候选，防止过期会话混入导入 [事务]
      setSelectedSessionIds((previous) =>
        previous.filter((sessionId) =>
          nextCandidates.some((candidate) => candidate.sessionId === sessionId),
        ),
      );
      logger.info(
        `[Migration] Claude 原生历史扫描完成 workspaceFilter=${effectiveWorkspacePath ?? "all"} count=${nextCandidates.length}`,
      );
    // 扫描异常统一转成可读文案写入 scanError
    // 错误只影响错误提示位，不清空候选，界面仍可读 [失败路径]
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error("[Migration] 扫描 Claude 原生历史失败", error);
      setScanError(message);
    } finally {
      setIsScanning(false);
    }
  }, [
    zcodeTaskService,
    effectiveWorkspaceIdentity,
    effectiveWorkspacePath,
    range,
    scanLimit,
    supportState.supported,
  ]);

  // 导入入口同时校验能力与会话数，任一不满足即直接返回
  // 这里同样没有并发去重，重复触发会并发写同一批会话，靠后端幂等兜底 [并发]
  // 失败返回 null 而不是抛错，让调用方据此判断这批是否落地 [事务]
  const importSessions = useCallback(async (sessionIds: string[]) => {
    if (!supportState.supported || sessionIds.length === 0) {
      return null;
    }

    setIsImporting(true);
    setImportError(null);

    try {
      logger.info(
        `[Migration] 开始导入 Claude 原生历史 workspaceFilter=${effectiveWorkspacePath ?? "all"} selected=${sessionIds.length}`,
      );
      // 导入请求只带工作区与选中的会话 id 集合
      // 请求体不掺入分页或时间参数，语义与扫描彻底分开 [事务]
      const result = await zcodeTaskService.importClaudeSessions({
        workspacePath: effectiveWorkspacePath,
        ...(effectiveWorkspaceIdentity
          ? { workspaceIdentity: effectiveWorkspaceIdentity }
          : {}),
        sessionIds,
      });
      setLastImportResult(result);
      // 成功、跳过、失败三类都算已处理，统一并入一个集合
      // 用一个集合一次性剔除勾选，避免三类各写一遍过滤 [事务]
      const handledSessionIds = new Set([
        ...result.imported.map((item) => item.sessionId),
        ...result.skipped.map((item) => item.sessionId),
        ...result.failed.map((item) => item.sessionId),
      ]);
      setSelectedSessionIds((previous) =>
        previous.filter((sessionId) => !handledSessionIds.has(sessionId)),
      );
      // 只有 result.imported.length > 0 才建标签并失效缓存。
      // 空结果跳过整段副作用，否则会触发一次无意义的全量刷新 [权衡]。
      if (result.imported.length > 0) {
        const importedWorkspacePaths = new Set(
          result.imported.map((item) => item.workspacePath),
        );
        // Bugfix: Claude 导入之前通过 bumpTaskListVersion 让各处任务列表整轮重查，
        // 但这里真正需要的只是把受影响 workspace 的查询结果失效并重新拉取。
        // 改成局部失效后，仍然能让新导入任务出现在侧边栏，同时避免把无关 workspace 一起带着刷新。
        const importedWorkspaceScopes = result.imported.map((item) => ({
          workspacePath: item.workspacePath,
        }));
        for (const workspacePath of importedWorkspacePaths) {
          // 每个受影响工作区都要确保有标签页，批量导入跨多个仓库时会连续打开多页，收尾关闭留给用户。
          tabStoreApi.getState().ensureWorkspaceTab(workspacePath);
        }
        invalidateTaskQueryCacheByScopes(importedWorkspaceScopes);
      }
      logger.info(
        `[Migration] Claude 原生历史导入完成 workspaceFilter=${effectiveWorkspacePath ?? "all"} imported=${result.imported.length} skipped=${result.skipped.length} failed=${result.failed.length}`,
      );
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error("[Migration] 导入 Claude 原生历史失败", error);
      setImportError(message);
      return null;
    } finally {
      setIsImporting(false);
    }
  }, [
    zcodeTaskService,
    effectiveWorkspaceIdentity,
    effectiveWorkspacePath,
    supportState.supported,
    tabStoreApi,
  ]);

  const importSelectedSessions = useCallback(async () => {
    return importSessions(selectedSessionIds);
  }, [importSessions, selectedSessionIds]);

  return {
    supportState,
    workspaceFilterMode,
    setWorkspaceFilterMode,
    hasCurrentWorkspaceFilter: params.workspacePath !== null,
    range,
    setRange,
    limitInput,
    setLimitInput,
    scanLimit,
    candidates,
    selectedSessionIds,
    selectedCount: selectedSessionIds.length,
    scanError,
    importError,
    lastImportResult,
    isScanning,
    isImporting,
    scan,
    importSessions,
    importSelectedSessions,
    toggleSessionSelection,
    selectAllSessions,
    clearSelectedSessions,
  };
}
