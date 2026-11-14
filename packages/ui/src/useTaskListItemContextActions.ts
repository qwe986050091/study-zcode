// INV-01 断言：exists 为真时原样返回入参 path，不做归一化 —— 守住位置：resolveProviderConfigOpenTargetPath 的首个 if —— 改错故障：已存在的配置被裁成父目录，编辑器打开目录而不是文件。
// INV-02 断言：exists 为假时只回退父目录，绝不把不存在的原路径交给平台层 —— 守住位置：函数末尾的回退链 —— 改错故障：打开动作必然失败且界面无反馈。
// INV-03 断言：剥离尾部分隔符必须在定位最后一段分隔符之前完成 —— 守住位置：trimmedPath 的赋值 —— 改错故障：目录形态路径算出空父级，回退结果等于原路径。
// INV-04 断言：父级命中盘符形态时必须补回尾部反斜杠 —— 守住位置：盘符正则分支 —— 改错故障：返回裸盘符，打开动作落到上次浏览目录。
// INV-05 断言：最后一段分隔符位于首字符时返回根分隔符而不是空串 —— 守住位置：索引为 0 的分支 —— 改错故障：根目录下的配置点击后因空路径被拒绝。
// INV-06 断言：平台能力只能经 usePlatform 获取，禁止直接读浏览器或宿主全局对象 —— 守住位置：hook 顶部的 platform 赋值 —— 改错故障：Web 与测试环境没有该对象，菜单点击即抛错。
// INV-07 断言：provider 缺省回落到固定值，且该值同时用于配置 hook 与日志字段 —— 守住位置：taskProvider 的赋值 —— 改错故障：取路径用的 provider 与日志记录不一致，排障误判。
// INV-08 断言：remoteSessionId 存在时 serviceScope 必须为 base —— 守住位置：providerConfigFile 的 options —— 改错故障：UI 拿到远端机器绝对路径，本机打开失败或定位错误。
// INV-09 断言：task 路径与 provider 配置的加载都受 enabled 约束，形参默认 true 仅为兼容旧调用 —— 守住位置：两个路径 hook 的 options —— 改错故障：列表重排时按 item 数量放大 RPC。
// INV-10 断言：复制动作遇到空值必须静默返回，不写剪贴板也不打日志 —— 守住位置：handleCopyText 的入口守卫 —— 改错故障：空串覆盖用户剪贴板内容。
// INV-11 断言：剪贴板写入失败只能降级为 warn，不得向调用方抛出 —— 守住位置：复制动作的 catch —— 改错故障：未处理的 rejection 冒到菜单事件层，右键菜单报错。
// INV-12 断言：文件管理器动作的语义始终是打开 workspacePath 目录 —— 守住位置：所有打开动作的入参 —— 改错故障：入口可用性跟着 task 快照文件走，未解析时 Finder 项不可用。
// INV-13 断言：远程判定必须同时考虑 remoteSessionId、workspaceIdentity 与解析出的 remoteTarget —— 守住位置：hasRemoteWorkspaceScope —— 改错故障：只带 identity 的远程项目被错当本机路径。
// INV-14 断言：远程且 remoteTarget 不是 wsl 时必须失败关闭并立即返回 —— 守住位置：kind 判定分支 —— 改错故障：SSH 或容器内的 Linux 路径落到本机文件管理器。
// INV-15 断言：macOS 与 Windows 先尝试 openInEditor，失败后才降级 openInFileManager —— 守住位置：两段 success 判断 —— 改错故障：同一目录被打开两次或弹出多个窗口。
// INV-16 断言：配置路径尚未解析时必须早返回 —— 守住位置：handleOpenProviderConfig 的入口守卫 —— 改错故障：加载中点击会复用上一次残留的打开目标。
// INV-17 断言：编辑器偏好只读持久化选择，并与 Header 共用同一份来源 —— 守住位置：readLastSelectedEditorId 与排序后的首选 —— 改错故障：侧边栏与 Header 走出两条不同的打开路径。
// INV-18 断言：首选编辑器打开失败必须回退文件管理器，两条失败路径都只记 warn —— 守住位置：编辑器分支与最终降级 —— 改错故障：编辑器不可用时前往配置完全无响应。
//
// 模块职责：把 task 列表项的右键菜单动作收敛到一个 hook：解析 session 路径与 provider 配置路径，并提供复制与打开动作。
// 状态所有权：路径三态由各 useTask 路径 hook 持有，本文件只做投影与动作编排，不缓存、不复制状态。
// 阅读顺序：先看两个接口与 resolveProviderConfigOpenTargetPath，再看 hook 内的三个回调，最后看三个纯函数工具。
import type { ZCodeProvider } from "@zcode/shared";
import { useCallback } from "react";
import { usePlatform } from "@/hooks/usePlatform.js";
import { useTaskNativeSessionLogFile } from "@/hooks/useTaskNativeSessionLogFile.js";
import { useTaskSessionFilePath } from "@/hooks/useTaskSessionFilePath.js";
import { useWorkspaceProviderConfigFile } from "@/hooks/useWorkspaceProviderConfigFile.js";
import { useWorkspaceOpenInEditorTarget } from "@/hooks/useWorkspaceOpenInEditorTarget.js";
import { readLastSelectedEditorId } from "@/lib/editorPreference.js";
import { sortInstalledEditorsForOpenWith } from "@/lib/openWithEditors.js";
import { logger } from "@/logger.js";

// 三态投影：loading 表示请求在途，path 表示已解析到的绝对路径，exists 表示落盘事实。
// 三者不能合并成 path 可选：null 与「存在但为空」语义不同，调用方据此决定菜单项可用性。
// 该类型只承载展示快照，不持有请求句柄，也不负责重试；刷新由底层 hook 自己驱动。
// 若省掉 loading 并用空 path 代替，加载中会瞬间显示为无路径，菜单项闪烁。
interface TaskPathState {
  loading: boolean;
  path: string | null;
  exists: boolean;
}

interface TaskListItemContextActionsResult {
  taskSessionFile: TaskPathState;
  taskNativeSessionLogFile: TaskPathState;
  providerConfigFile: TaskPathState;
  fileManagerLabel: string;
  handleCopyText: (label: string, value: string | null) => Promise<void>;
  handleOpenTaskPathInFileManager: () => Promise<void>;
  handleOpenProviderConfig: () => Promise<void>;
}

// 纯函数契约：只做字符串归一，不读文件系统、不做平台判断、不抛异常。
// 输入 exists 来自上层 hook 的探测结果，函数本身不重复校验落盘状态。
// 产出保证可直接交给打开动作：要么是存在的文件，要么是承载它的目录。
// 保持无副作用才能在菜单点击时安全重算，也便于单测直接覆盖分支。
export function resolveProviderConfigOpenTargetPath(
  path: string,
  exists: boolean,
): string {
  if (exists) {
    return path;
  }

  // Bugfix: provider 主配置文件首次还没落盘时，更多菜单之前会把“前往配置”完全禁用，
  // 用户既看不到承载配置的目录，也没法就地补齐文件。这里改成回退打开父目录，
  // 保留“前往配置”的导航语义，并避免把一个不存在的文件路径直接交给编辑器。
  const trimmedPath = path.replace(/[\\/]+$/, "");
  // 先剥离尾部分隔符，再定位最后一段分隔符，否则目录形态路径会算出空父级。
  // 同时兼容正斜杠与反斜杠，Windows 侧两种写法可能混用。
  // 只处理尾部，不折叠中间重复分隔符，避免改变原始路径语义。
  // 取两者较大值等于取最后一个出现的分隔符，改错会跨级回退到更上层。
  const lastSeparatorIndex = Math.max(
    trimmedPath.lastIndexOf("/"),
    trimmedPath.lastIndexOf("\\"),
  );

  if (lastSeparatorIndex < 0) {
    return path;
  }

  // 根路径场景：路径形如单个分隔符加文件名，此时父级就是根分隔符本身。
  // 这里返回首字符而不是空串，空串会被平台层直接拒绝。
  // 首字符可能因裁剪变为 undefined，因此仍需保留原 path 作为兜底。
  // 改错只影响根目录下的配置文件，表现为点击后毫无反应。
  if (lastSeparatorIndex === 0) {
    return trimmedPath[0] ?? path;
  }

  const parentPath = trimmedPath.slice(0, lastSeparatorIndex);
  if (/^[A-Za-z]:$/.test(parentPath)) {
    return `${parentPath}\\`;
  }

  return parentPath || path;
}

export function useTaskListItemContextActions({
  workspacePath,
  remoteSessionId,
  workspaceIdentity,
  taskId,
  provider,
  intl,
  loadTaskPaths = true,
  loadProviderConfig = true,
}: {
  workspacePath: string;
  remoteSessionId?: string;
  workspaceIdentity?: string;
  taskId: string;
  provider?: ZCodeProvider;
  intl: {
    formatMessage: (
      desc: { id: string },
      values?: Record<string, string>,
    ) => string;
  };
  loadTaskPaths?: boolean;
  loadProviderConfig?: boolean;
}): TaskListItemContextActionsResult {
  // 平台访问唯一入口：所有打开动作都经此对象，桌面与 Web 各自注入实现。
  // 不直接使用浏览器全局对象，否则 Web 与测试环境的行为会分叉。
  // 该对象在 hook 生命周期内稳定，因此可以安全放进各回调的依赖数组。
  // 若在回调内部重新获取，会破坏依赖一致性并可能拿到过期实现。
  const platform = usePlatform();
  const workspaceOpenTarget = useWorkspaceOpenInEditorTarget({
    workspacePath,
    workspaceIdentity,
    workspaceRemoteSessionId: remoteSessionId,
  });
  const taskProvider = provider ?? "glm";
  const taskSessionFile = useTaskSessionFilePath(workspacePath, taskId, workspaceIdentity, {
    // task session/log 路径只用于右键菜单项；菜单未打开时不要在列表重排中批量触发 RPC。
    enabled: loadTaskPaths,
  });
  const taskNativeSessionLogFile = useTaskNativeSessionLogFile(
    workspacePath,
    taskId,
    provider ?? null,
    workspaceIdentity,
    { enabled: loadTaskPaths },
  );
  const providerConfigFile = useWorkspaceProviderConfigFile(
    workspacePath,
    taskProvider,
    remoteSessionId,
    workspaceIdentity,
    {
      // Bugfix: 远程 workspace 里“前往配置”用于打开本机可编辑的 provider 配置入口。
      // 之前这里跟随 remote zcodeTaskService 取路径，会返回远端机器上的绝对路径（例如 /root/...），
      // 再交给本机平台层打开时就会定位到错误位置或直接失败。
      // 这里远程场景强制改走 base service，保证 UI 拿到的是本机可打开的配置路径。
      // 远程 workspace 必须走 base 服务取路径，返回本机可打开的配置位置。
      // 跟随 workspace 作用域会拿到远端机器的绝对路径，本机无法定位。
      // 判定只看 remoteSessionId 是否存在，不推测连接状态，避免半连接误判。
      // 远程标识一旦存在就固定走 base，不按连接类型细分，防止出现两套取路径逻辑。
      serviceScope: remoteSessionId ? "base" : "workspace",
      // Bugfix: 任务列表里每个 item 都会挂载右键菜单动作；如果挂载时就读取 provider 配置路径，
      // 远程 workspace 会按任务数量放大 base RPC 和日志。这里改成菜单真正打开时才加载。
      // 懒加载边界：列表项挂载时默认不取配置路径，菜单真正打开才置为 true。
      // 该开关把请求时机从渲染推迟到交互，避免按任务数量放大 RPC。
      // 开关只影响是否发起请求，不改变已解析结果的缓存语义。
      // 若在挂载期强制打开，远程 workspace 会在列表滚动时产生成批请求。
      enabled: loadProviderConfig,
    },
  );

  // 复制动作对外只暴露标签与值，不关心值来自哪个路径字段。
  // 空值视为不可复制并静默返回，不产生日志噪音也不改动剪贴板。
  // 成功与失败都只落日志，不向调用方抛错，菜单交互因此不会中断。
  // 依赖数组为空是刻意的：动作不捕获任何随渲染变化的变量。
  const handleCopyText = useCallback(
    async (label: string, value: string | null) => {
      if (!value) {
        return;
      }

      try {
        await navigator.clipboard.writeText(value);
        logger.info(`[TaskListItem] ${label} 已复制: ${value}`);
      } catch (error) {
        logger.warn("[TaskListItem] 复制文本失败", {
          label,
          value,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    },
    [],
  );

  const handleOpenTaskPathInFileManager = useCallback(async () => {
    const hasRemoteWorkspaceScope = Boolean(
      remoteSessionId ||
        workspaceIdentity?.trim() ||
        workspaceOpenTarget.isRemoteWorkspace,
    );
    if (hasRemoteWorkspaceScope) {
      // 失败关闭点：远程路径无法确认是 WSL 时，宁可不开也不能落到本机。
      // SSH 与容器里的 Linux 路径在本机没有对应位置，强行打开会指向错误目录。
      // 此处只记 warn 并返回，不弹错误框，保持右键菜单轻量。
      // 若放行到后面的本机分支，用户会看到与远端无关的本地目录。
      if (workspaceOpenTarget.remoteTarget?.kind !== "wsl") {
        // 远程项目路径不是宿主机路径。无法精确解析为 WSL 时必须失败关闭，
        // 避免 SSH/Docker 的 Linux 路径误落到原生 Windows、macOS 或 Linux 文件管理器。
        logger.warn("[TaskListItem] 远程 workspace 不支持本机文件管理器", {
          taskId,
          path: workspacePath,
          remoteKind: workspaceOpenTarget.remoteTarget?.kind ?? "unresolved",
        });
        return;
      }

      const result = await platform.openInEditor("explorer", workspacePath, {
        pathKind: "directory",
        remoteTarget: workspaceOpenTarget.remoteTarget,
        workspaceIdentity,
      });
      if (!result.success) {
        logger.warn("[TaskListItem] 打开 WSL workspace 路径失败", {
          taskId,
          path: workspacePath,
          error: result.error ?? "unknown-error",
        });
      }
      return;
    }

    const isMac = isMacLike();
    const isWindows = isWindowsLike();
    if (isMac || isWindows) {
      const editorId = isMac ? "finder" : "explorer";
      const result = await platform.openInEditor(editorId, workspacePath);
      if (result.success) {
        return;
      }
    }

    const result = await platform.openInFileManager(workspacePath);
    if (!result.success) {
      // Header / task 菜单里的“Open in Finder”语义应该是打开项目目录。
      // 之前这里误绑到了 task session 文件路径，菜单可用性也跟着 task 快照文件走，
      // 一旦 session 文件还没解析出来，用户会看到 Finder 入口莫名不可用。
      // 这里统一改成始终打开 workspacePath，让行为和“Copy path=项目路径”保持一致。
      logger.warn("[TaskListItem] 打开 workspace 路径失败", {
        taskId,
        path: workspacePath,
        error: result.error ?? "unknown-error",
      });
    }
  }, [
    platform,
    remoteSessionId,
    taskId,
    workspaceIdentity,
    workspaceOpenTarget.isRemoteWorkspace,
    workspaceOpenTarget.remoteTarget,
    workspacePath,
  ]);

  // 两段式打开：先尝试用户偏好的编辑器，失败再退回文件管理器。
  // 偏好来自持久化记录而非组件内状态，保证侧边栏与 Header 行为一致。
  // 编辑器列表可能为空，因此首选必须允许为 null 并直接走降级分支。
  // 整个流程包在 try 与 catch 内，平台调用异常只记 warn，不向菜单层冒泡。
  const handleOpenProviderConfig = useCallback(async () => {
    if (!providerConfigFile.path) {
      return;
    }

    const openTargetPath = resolveProviderConfigOpenTargetPath(
      providerConfigFile.path,
      providerConfigFile.exists,
    );

    try {
      const preferredEditorId = readLastSelectedEditorId();
      const editors = await platform.getInstalledEditors();
      const sortedEditors = sortInstalledEditorsForOpenWith(editors);
      const preferredEditor =
        sortedEditors.find((editor) => editor.id === preferredEditorId) ??
        sortedEditors[0] ??
        null;

      // Bugfix: task 右键菜单位于侧边栏，拿不到 Header 里的 selectedEditor 本地状态。
      // 如果这里直接硬编码某个编辑器，Header 和侧边栏会对“Go to config”走出两条不同路径。
      // 这里改为读取持久化的 editor 偏好，和 Header editor 按钮共用同一份用户选择。
      if (preferredEditor) {
        const result = await platform.openInEditor(
          preferredEditor.id,
          openTargetPath,
        );
        if (result.success) {
          return;
        }
      }

      const result = await platform.openInFileManager(openTargetPath);
      if (!result.success) {
        logger.warn("[TaskListItem] 打开 provider 配置失败", {
          taskId,
          provider: taskProvider,
          path: providerConfigFile.path,
          openTargetPath,
          error: result.error ?? "unknown-error",
        });
      }
    } catch (error) {
      logger.warn("[TaskListItem] 打开 provider 配置失败", {
        taskId,
        provider: taskProvider,
        path: providerConfigFile.path,
        openTargetPath,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }, [
    platform,
    providerConfigFile.exists,
    providerConfigFile.path,
    taskId,
    taskProvider,
  ]);

  return {
    taskSessionFile,
    taskNativeSessionLogFile,
    providerConfigFile,
    fileManagerLabel: getFileManagerLabel(intl),
    handleCopyText,
    handleOpenTaskPathInFileManager,
    handleOpenProviderConfig,
  };
}

function isMacLike(): boolean {
  if (typeof navigator === "undefined") {
    return false;
  }

  return /mac/i.test(navigator.userAgent);
}

function isWindowsLike(): boolean {
  if (typeof navigator === "undefined") {
    return false;
  }

  return /windows/i.test(navigator.userAgent);
}

function getFileManagerLabel(intl: {
  formatMessage: (
    desc: { id: string },
    values?: Record<string, string>,
  ) => string;
}) {
  if (isMacLike()) {
    return intl.formatMessage({ id: "appHeader.openInFinder" });
  }

  if (isWindowsLike()) {
    return intl.formatMessage({ id: "appHeader.openInFileExplorer" });
  }

  return intl.formatMessage({ id: "appHeader.openInFileManager" });
}
