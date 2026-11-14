// INV-01 配置路径必须由任务服务给出，UI 不得自行拼接：守住位置 读取调用；改错故障 路径规则在两端分叉。
// INV-02 工作区作用域直接使用工作区服务：守住位置 解析函数首分支；改错故障 基础作用域被错误覆盖。
// INV-03 基础作用域优先使用基础服务：守住位置 第二分支；改错故障 已就绪的基础服务被绕过。
// INV-04 远程会话缺少基础服务时必须返回空：守住位置 远程分支；改错故障 回退到远端绝对路径，本机无法打开。
// INV-05 远程会话就绪前保持加载态而不是报错：守住位置 空服务分支；改错故障 断连恢复被记录成读取失败。
// INV-06 工作区路径或开关缺失时直接清空状态：守住位置 首段早退；改错故障 旧 provider 的路径继续展示。
// INV-07 每次请求都必须递增版本号：守住位置 请求版本引用；改错故障 旧响应覆盖新 provider 的结果。
// INV-08 发起请求时立即清空路径与存在标记：守住位置 请求前状态写入；改错故障 用户点到上一个 provider 的文件。
// INV-09 成功与失败回调都必须校验销毁标记与版本号：守住位置 两处早退；改错故障 卸载后仍写状态。
// INV-10 卸载时必须置销毁标记：守住位置 清理函数；改错故障 迟到响应触发状态更新警告。
// INV-11 错误消息必须依次尝试消息、名称与字符串化：守住位置 getErrorMessage；改错故障 错误显示为空。
// INV-12 初始状态固定为加载中：守住位置 INITIAL_STATE；改错故障 首帧闪现「文件不存在」。
// INV-13 依赖数组必须覆盖请求涉及的全部输入：守住位置 副作用依赖；改错故障 provider 切换不重新读取。
// INV-14 刷新通过递增版本触发，而不是直接调用读取：守住位置 refresh 回调；改错故障 绕过副作用生命周期。
// INV-15 返回对象在字段未变时保持引用稳定：守住位置 末尾记忆化；改错故障 父级重渲击穿下游 memo。
// INV-16 作用域展示值区分基础与远程两种来源：守住位置 作用域三元表达式；改错故障 日志中的来源标注错误。
// INV-17 工作区 RPC 不可用时不得发起读取：守住位置 可用性判断；改错故障 断连代理被反复访问。
// INV-18 日志必须带工作区、provider、作用域与会话：守住位置 两处日志；改错故障 多窗口问题无法定位。
//
// 模块职责：解析当前工作区与 provider 对应的配置文件路径，并暴露刷新入口。
// 状态所有权：路径、存在标记、加载与错误状态由本 hook 持有；实际文件归任务服务管理。
// 阅读顺序：先看错误格式化与服务解析，再读 hook 入参与副作用，最后看记忆化返回。
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ZCodeProvider } from "@zcode/shared";
import { logger } from "@/logger.js";
import { shouldEnableWorkspaceRpc } from "@/lib/workspaceRpcAvailability.js";
import { useZCodeTaskService } from "@/hooks/useZCodeTaskService.js";
import { useRemoteWorkspaceSessionStore } from "@/store/remoteWorkspaceSessionStore.js";
import { useResolvedRemoteWorkspaceSessionId } from "@/hooks/useResolvedRemoteWorkspaceSessionId.js";
import type { IZCodeTaskService } from "@zcode/services";

interface WorkspaceProviderConfigFileState {
  path: string | null;
  exists: boolean;
  loading: boolean;
  error: string | null;
}

// getErrorMessage 对 Error 取 message，缺失时退到 name
// 普通对象带 message 字段时按字符串读取
// 其余值直接 String(error)
function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message || error.name || String(error);
  }

  if (typeof error === "object" && error !== null && "message" in error) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === "string" && message.length > 0) {
      return message;
    }
  }

  return String(error);
}

// INITIAL_STATE.path 为 null，不假设文件存在
// INITIAL_STATE.loading 从 true 开始，避免首帧误报
// INITIAL_STATE.error 初始为 null
const INITIAL_STATE: WorkspaceProviderConfigFileState = {
  path: null,
  exists: false,
  loading: true,
  error: null,
};

type WorkspaceProviderConfigServiceScope = "workspace" | "base";

// configuredServiceScope === "workspace" 时无条件用 workspaceZCodeService
// "base" 作用域优先使用已就绪的 baseZCodeService
// 远程会话没有基础服务时返回 null，等待就绪
// 本地场景最后回退到 workspaceZCodeService
// resolveWorkspaceProviderConfigZCodeService 是唯一分派点
export function resolveWorkspaceProviderConfigZCodeService(params: {
  configuredServiceScope: WorkspaceProviderConfigServiceScope;
  workspaceZCodeService: IZCodeTaskService;
  baseZCodeService: IZCodeTaskService | null;
  remoteSessionId: string | null;
}): IZCodeTaskService | null {
  if (params.configuredServiceScope === "workspace") {
    return params.workspaceZCodeService;
  }

  if (params.baseZCodeService) {
    return params.baseZCodeService;
  }

  // Bugfix: 远程 workspace 下如果误回退到 workspaceZCodeService，
  // “前往配置”会读到远端绝对路径（如 /root/...），本机无法正确打开。
  // 这里在远程会话里严格要求 baseZCodeService，就绪前先等待，不再冒险走错误 fallback。
  if (params.remoteSessionId) {
    return null;
  }

  return params.workspaceZCodeService;
}

/**
 * 读取当前 workspace + provider 的主配置文件路径。
 *
 * 统一通过 zcodeTaskService 获取路径规则，避免 UI 层拼接 provider 配置路径。
 */
// 入参包含工作区、provider、远程会话与作用域选项。
// 工作区服务由统一 hook 解析。
// 远程会话标识与基础服务分别订阅。
// RPC 可用性与服务选择都先于读取计算。
// 返回值只包含状态快照与刷新函数。
export function useWorkspaceProviderConfigFile(
  workspacePath: string,
  provider: ZCodeProvider,
  preferredRemoteSessionId?: string | null,
  workspaceIdentity?: string,
  options?: {
    serviceScope?: "workspace" | "base";
    enabled?: boolean;
  },
) {
  const workspaceZCodeService = useZCodeTaskService(
    workspacePath,
    preferredRemoteSessionId,
    workspaceIdentity,
  );
  const configuredServiceScope = options?.serviceScope ?? "workspace";
  const enabled = options?.enabled ?? true;
  const remoteSessionId = useResolvedRemoteWorkspaceSessionId(
    workspacePath,
    preferredRemoteSessionId,
    workspaceIdentity,
  );
  const baseZCodeService = useRemoteWorkspaceSessionStore(
    (state) => state.baseServices?.zcodeTaskService ?? null,
  );
  const workspaceRpcEnabled = shouldEnableWorkspaceRpc({
    workspaceIdentity,
    remoteSessionId,
  });
  const zcodeTaskService = resolveWorkspaceProviderConfigZCodeService({
    configuredServiceScope,
    workspaceZCodeService,
    baseZCodeService,
    remoteSessionId,
  });
  const zcodeServiceScope =
    configuredServiceScope === "base"
      ? "base"
      : remoteSessionId && workspaceZCodeService !== baseZCodeService
        ? "remote"
        : "base";
  const [state, setState] =
    useState<WorkspaceProviderConfigFileState>(INITIAL_STATE);
  const [refreshVersion, setRefreshVersion] = useState(0);
  const requestVersionRef = useRef(0);

  const refresh = useCallback(() => {
    setRefreshVersion((current) => current + 1);
  }, []);

  // 每次副作用运行都创建独立销毁标记。
  // 路径缺失、关闭或 RPC 不可用时清空并结束。
  // 服务未就绪时保持加载态，不发起请求。
  // 请求前递增版本并立即清空旧路径。
  // [并发] 成功与失败回调都同时校验销毁标记与版本号。
  // 依赖变化会重新运行，旧请求自然失效。
  useEffect(() => {
    let disposed = false;

    if (!workspacePath || !enabled || !workspaceRpcEnabled) {
      requestVersionRef.current += 1;
      // Bugfix: 恢复断连远端 workspace 时，provider 配置路径读取不能抢在 remote session
      // 绑定前访问断连代理，否则会把 ZCODE_REMOTE_WORKSPACE_DISCONNECTED 记录成配置读取失败。
      setState({
        path: null,
        exists: false,
        loading: false,
        error: null,
      });
      return () => {
        disposed = true;
      };
    }

    if (!zcodeTaskService) {
      requestVersionRef.current += 1;
      setState({
        path: null,
        exists: false,
        loading: true,
        error: null,
      });
      return () => {
        disposed = true;
      };
    }

    const requestVersion = requestVersionRef.current + 1;
    requestVersionRef.current = requestVersion;

    // Bugfix: provider 切换时如果保留旧 path，用户会在新请求返回前误点到上一个 provider 的配置文件。
    // 这里在发起请求时立即清空 path/exists，配合 requestVersion 仅接受最新响应，避免旧结果回写。
    setState({
      path: null,
      exists: false,
      loading: true,
      error: null,
    });

    logger.info(
      `[useWorkspaceProviderConfigFile] 开始读取 provider 配置路径 workspace=${workspacePath} provider=${provider} scope=${zcodeServiceScope} session=${remoteSessionId ?? "none"}`,
    );

    void zcodeTaskService
      .getWorkspaceProviderConfigFile({
        workspacePath,
        ...(workspaceIdentity ? { workspaceIdentity } : {}),
        provider,
      })
      .then((result) => {
        if (disposed || requestVersionRef.current !== requestVersion) {
          return;
        }

        logger.info(
          `[useWorkspaceProviderConfigFile] 读取 provider 配置路径成功 workspace=${workspacePath} provider=${provider} scope=${zcodeServiceScope} session=${remoteSessionId ?? "none"} exists=${result.exists} path=${result.path}`,
        );

        setState({
          path: result.path,
          exists: result.exists,
          loading: false,
          error: null,
        });
      })
      .catch((error: unknown) => {
        if (disposed || requestVersionRef.current !== requestVersion) {
          return;
        }

        const message = getErrorMessage(error);
        logger.warn("[useWorkspaceProviderConfigFile] 读取 provider 配置路径失败", {
          workspacePath,
          provider,
          scope: zcodeServiceScope,
          remoteSessionId,
          error: message,
        });
        setState({
          path: null,
          exists: false,
          loading: false,
          error: message,
        });
      });

    return () => {
      disposed = true;
    };
  }, [
    zcodeTaskService,
    zcodeServiceScope,
    enabled,
    provider,
    refreshVersion,
    remoteSessionId,
    workspaceIdentity,
    workspacePath,
    workspaceRpcEnabled,
  ]);

  // Bugfix: provider 配置状态会继续作为 Shell/Header/Menu props 透传。
  // 字段未变时复用返回对象，避免父级无关重渲让下游 memo 组件误判配置状态变化。
  // 状态字段未变时复用同一对象。
  // 刷新函数引用稳定，可安全下传。
  // 该记忆化避免无关重渲击穿下游 memo。
  // 返回结构保持扁平，便于调用方展开。
  return useMemo(
    () => ({
      ...state,
      refresh,
    }),
    [refresh, state],
  );
}
